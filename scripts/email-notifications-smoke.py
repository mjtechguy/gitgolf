#!/usr/bin/env python3
"""Prepared disposable SMTP qualification; source preparation is not runtime proof.

Requires exact existing local --image and --sink-image, new --output, optionally
--ui. Never builds/pulls or modifies the retained stack. Only owned local TLS
SMTP/control receivers are contacted. Codes/bodies remain in receiver/process
memory, never in evidence files. All fixtures are removed on terminal cleanup.
"""
import argparse
import ast
import base64
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import urllib.parse
import uuid
sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'EmailNotificationService/'
ACCOUNT_PATH = '/account/settings'
REPOSITORY_PATH = '/{owner}/{name}/settings/webhooks'
ADMIN_PATH = '/admin/settings/notifications'
NATIVE_IMAGE = 'gitea/gitea:1.27.3-rootless'
PG_IMAGE = 'postgres:18.4-alpine3.24'
STAGE = 'arguments'
OUTPUT = None
PROOF = {'status':'not_started','cleanup':'not_created','scope':'Verified local mailbox/category activity/owned implicit TLS SMTP acceptance, not inbox delivery/Cloudflare/provider bounces/recovery/scale'}
CA_CONFIG = '''[req]
distinguished_name=subject
x509_extensions=extensions
prompt=no
[subject]
CN=Golf-owned SMTP proof CA
[extensions]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
'''
SERVER_EXTENSIONS = '''subjectAltName=DNS:receiver.golf.test
extendedKeyUsage=serverAuth
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
'''
SINK = r'''
import email,email.policy,hashlib,hmac,json,re,socket,ssl,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from socketserver import ThreadingTCPServer,StreamRequestHandler
from pathlib import Path
cfg=json.loads(Path('/fixture/sink.json').read_text());lock=threading.Lock();receipts=[];codes={};unsubscribe={};modes={};counts={};recipients=set();connections=0
class SMTP(StreamRequestHandler):
 def handle(self):
  global connections
  self.connection.settimeout(15)
  with lock:connections+=1
  self.wfile.write(b'220 owned Golf SMTP receiver\r\n');self.wfile.flush();sender=recipient=None;bytes_read=0
  while True:
   line=self.rfile.readline(4097);bytes_read+=len(line)
   if not line or len(line)>4096 or bytes_read>32768:return
   command=line.decode('ascii').rstrip('\r\n');verb=command.split(' ',1)[0]
   if verb in ('EHLO','HELO'):reply=b'250-owned fixture\r\n250 8BITMIME\r\n'
   elif verb=='MAIL':
    assert command=='MAIL FROM:<sender@example.invalid>'+(' BODY=8BITMIME' if ' BODY=8BITMIME' in command else '')
    sender='sender@example.invalid';reply=b'250 sender\r\n'
   elif verb=='RCPT':
    assert sender and recipient is None;recipient=command.removeprefix('RCPT TO:<').removesuffix('>')
    with lock:assert recipient in recipients
    reply=b'250 recipient\r\n'
   elif verb=='DATA':
    assert sender and recipient;self.wfile.write(b'354 send bounded message\r\n');self.wfile.flush();body=bytearray()
    while True:
     chunk=self.rfile.readline(1001)
     if chunk==b'.\r\n':break
     assert chunk and len(chunk)<=1000
     body.extend(chunk[1:] if chunk.startswith(b'..') else chunk);assert len(body)<=16384
    msg=email.message_from_bytes(bytes(body),policy=email.policy.SMTP)
    match=re.fullmatch(r'<([a-f0-9-]{36})@golf.notifications>',msg['Message-ID']);assert match
    delivery=match.group(1);assert str(__import__('uuid').UUID(delivery))==delivery
    text=msg.get_content();assert msg['From']==sender and msg['To']==recipient and msg['Auto-Submitted']=='auto-generated' and msg['Date']
    assert msg.get_content_type()=='text/plain' and msg['Content-Transfer-Encoding']=='quoted-printable'
    challenge=re.search(r'verification code is ([0-9]{8})',text)
    private_absent='PRIVATE_EMAIL_QUALIFIER_BODY' not in text and 'PAID_PROVIDER' not in text
    with lock:
     assert len(receipts)<2000;counts[delivery]=counts.get(delivery,0)+1;attempt=counts[delivery];mode=modes.get(delivery,'accept')
     if challenge:codes[delivery]={'code':challenge.group(1),'expires':time.monotonic()+1800}
     links=[line for line in text.splitlines() if '/notifications/unsubscribe?token=' in line]
     if not challenge:assert len(links)==1 and links[0].startswith(cfg['golf']+'/notifications/unsubscribe?token=');unsubscribe[delivery]=links[0]
     receipts.append({'deliveryId':delivery,'attempt':attempt,'mode':mode,'bodyBytes':len(body),'bodySha256':hashlib.sha256(body).hexdigest(),'verification':bool(challenge),'privateBodyExcluded':private_absent,'recipientMatchesEnvelope':True,'senderMatchesEnvelope':True,'smtpReply':None if mode=='drop_once' and attempt==1 else 451 if mode=='retry_once' and attempt==1 else 250})
    del body,text,msg,challenge
    if mode=='drop_once' and attempt==1:self.connection.shutdown(socket.SHUT_RDWR);return
    reply=b'451 4.3.0 owned transient refusal\r\n' if mode=='retry_once' and attempt==1 else b'250 owned relay accepted\r\n'
   elif verb=='QUIT':self.wfile.write(b'221 closed\r\n');self.wfile.flush();return
   else:reply=b'500 unsupported\r\n'
   self.wfile.write(reply);self.wfile.flush()
class Control(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def handle_control(self):
  assert hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+cfg['controlKey'])
  with lock:
   if self.command=='GET' and self.path=='/receipts':out={'receipts':list(receipts),'connections':connections}
   elif self.command=='GET' and self.path.startswith('/code/'):
    item=codes.pop(self.path[6:]);assert item['expires']>time.monotonic();out={'code':item['code']}
   elif self.command=='GET' and self.path.startswith('/unsubscribe/'):
    out={'url':unsubscribe.pop(self.path[13:])}
   elif self.command=='POST':
    size=int(self.headers.get('Content-Length','0'));assert 0<size<=4096;data=json.loads(self.rfile.read(size))
    if self.path=='/recipients':assert len(data['recipients'])<=16;recipients.update(data['recipients']);out={'configured':True}
    elif self.path=='/mode':assert data['mode'] in ('accept','retry_once','drop_once') and re.fullmatch(r'[a-f0-9-]{36}',data['id']);modes[data['id']]=data['mode'];out={'configured':True}
    else:raise ValueError()
   else:raise ValueError()
  encoded=json.dumps(out).encode();self.send_response(200);self.send_header('Cache-Control','no-store');self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded)
 def do_GET(self):
  try:self.handle_control()
  except Exception:self.send_response(404);self.end_headers()
 def do_POST(self):
  try:self.handle_control()
  except Exception:self.send_response(400);self.end_headers()
class OwnedSMTPServer(ThreadingTCPServer):
 def handle_error(self,*args):pass
smtp=OwnedSMTPServer(('0.0.0.0',465),SMTP);smtp.daemon_threads=True
secure=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);secure.minimum_version=ssl.TLSVersion.TLSv1_2;secure.load_cert_chain('/fixture/server.crt','/fixture/server.key');smtp.socket=secure.wrap_socket(smtp.socket,server_side=True)
threading.Thread(target=smtp.serve_forever,daemon=True).start();ThreadingHTTPServer(('0.0.0.0',8765),Control).serve_forever()
'''


def record(**values):
    PROOF.update(values)
    if OUTPUT:
        temporary=OUTPUT/'manifest.json.tmp'
        with temporary.open('w') as out:
            temporary.chmod(0o600);json.dump(PROOF,out,indent=2,sort_keys=True);out.write('\n')
        temporary.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE=value;record(stage=value);print('CHECK: '+value,flush=True)


def private_write(path,value):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:out.write(value)


def positive(value,zero=False):
    return isinstance(value,str) and bool(re.fullmatch(r'0|[1-9][0-9]{0,18}',value)) and int(value)<=9223372036854775807 and (zero or value!='0')


def receiver_receipt(row):
    assert set(row)=={'deliveryId','attempt','mode','bodyBytes','bodySha256','verification','privateBodyExcluded','recipientMatchesEnvelope','senderMatchesEnvelope','smtpReply'}
    assert str(uuid.UUID(row['deliveryId']))==row['deliveryId'] and 1<=row['attempt']<=6 and row['mode'] in ('accept','retry_once','drop_once')
    assert 0<row['bodyBytes']<=16384 and re.fullmatch(r'[a-f0-9]{64}',row['bodySha256'])
    assert type(row['verification']) is bool and row['smtpReply'] in (None,250,451) and all(row[k] is True for k in ('privateBodyExcluded','recipientMatchesEnvelope','senderMatchesEnvelope'))
    return row


def checked_rpc(session,method,body=None,expected=200,headers=None,code=None):
    assert re.fullmatch(r'[A-Za-z]+Service/[A-Za-z]+',method)
    request=urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+method,data=json.dumps(body or {}).encode(),method='POST',headers={'Origin':smoke.GOLF,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(headers or {})})
    try:response=session.open(request,timeout=15)
    except urllib.error.HTTPError as error:response=error
    with response:
        raw=response.read((1<<20)+1);assert len(raw)<=1<<20
        result=json.loads(raw) if raw else None
        meta={'procedure':method,'status':response.status,'noStore':response.headers.get('Cache-Control')=='no-store'}
        if isinstance(result,dict) and isinstance(result.get('code'),str):meta['code']=result['code']
        record(lastProcedure=meta)
        assert response.status==expected and meta['noStore'],'RPC boundary mismatch; metadata only'
        if expected!=200:assert result['code']==(code or {400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found',429:'resource_exhausted',503:'unavailable'}[expected])
        return result


def self_check():
    ast.parse(SINK)
    source=(ROOT/'api/golf/v1/golf.proto').read_text()
    for method in ('ListEmailTransports','SaveEmailTransport','ActivateEmailTransport','GetOwnEmailNotifications','RequestEmailVerification','ConfirmEmailVerification','SaveOwnEmailPreference','GetRepositoryEmailSubscription','SaveRepositoryEmailSubscription','ListOwnEmailDeliveries','RedeliverOwnEmail'):
        assert 'rpc '+method+'(' in source
    row={'deliveryId':str(uuid.uuid4()),'attempt':1,'mode':'accept','bodyBytes':100,'bodySha256':hashlib.sha256(b'bounded owned message').hexdigest(),'verification':False,'privateBodyExcluded':True,'recipientMatchesEnvelope':True,'senderMatchesEnvelope':True,'smtpReply':250}
    receiver_receipt(row)
    for field,bad in [('privateBodyExcluded',False),('smtpReply',354),('bodyBytes',20000),('bodySha256','x'*64)]:
        try:receiver_receipt({**row,field:bad})
        except AssertionError:pass
        else:raise AssertionError('False receiver receipt accepted')
    assert positive('9007199254740993') and not positive('01') and not positive('9223372036854775808')
    assert 'write_text' not in SINK and 'bodyBase64' not in SINK and 'log_message(self,*args):pass' in SINK
    assert ACCOUNT_PATH=='/account/settings' and ADMIN_PATH=='/admin/settings/notifications'
    assert 'CA:TRUE' in CA_CONFIG and 'CA:FALSE' in SERVER_EXTENSIONS
    assert 'ISSUE_MUTATION_STATE_SUCCEEDED = 2;' in source and 'ISSUE_MUTATION_STATE_COMPLETE' not in source
    print('PASS: pure SMTP receiver AST, immutable receipt counterexamples, wire inventory, route and no-code/body persistence checks; no Docker/HTTP/SMTP/native operations',flush=True)


def main():
    global OUTPUT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true');parser.add_argument('--image');parser.add_argument('--sink-image');parser.add_argument('--output',type=Path);parser.add_argument('--ui',action='store_true')
    args=parser.parse_args()
    if args.self_check:self_check();return
    if not args.image or not args.sink_image or not args.output:parser.error('Require --image --sink-image and fresh --output')
    args.output.mkdir(parents=True,exist_ok=False,mode=0o700);OUTPUT=args.output.resolve();OUTPUT.chmod(0o700);record(status='running',browser='pending' if args.ui else 'not_requested')
    env={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k not in ('DATABASE_URL','DOCKER_HOST','DOCKER_CONTEXT','SSL_CERT_FILE','SSL_CERT_DIR')};env['COMPOSE_DISABLE_ENV_FILE']='true'
    def run(*command,payload=None,timeout=120):
        result=subprocess.run(command,cwd=ROOT,env=env,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode==0 and len(result.stdout)<=4<<20 and len(result.stderr)<=4<<20,'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('exact local image identity and reserve; no build or pull')
    images={};revision=None
    for name,reference in [('golf',args.image),('sink',args.sink_image),('native',NATIVE_IMAGE),('postgres',PG_IMAGE)]:
        row=json.loads(run('docker','image','inspect',reference))[0];assert re.fullmatch(r'sha256:[a-f0-9]{64}',row['Id']);images[name]=row['Id']
        if name=='golf':revision=(row['Config'].get('Labels') or {}).get('org.opencontainers.image.revision');assert re.fullmatch(r'[a-f0-9]{40}',revision or '')
    record(sourceRevision=revision,imageIds=images,workingSourceRevision=run('git','rev-parse','HEAD'))
    reserve=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',images['golf'],'-Pk','/');assert int(reserve.splitlines()[-1].split()[3])>=2*1024*1024
    if args.ui:assert (ROOT/'web/node_modules/playwright/index.mjs').is_file()
    spec=importlib.util.spec_from_file_location('email_ports',ROOT/'scripts/observability-smoke.py');helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
    ports=helpers.free_ports(3);previous=smoke.GOLF,smoke.GITEA;smoke.GOLF,smoke.GITEA=f'http://127.0.0.1:{ports[0]}',f'http://127.0.0.1:{ports[1]}'
    control_url=f'http://127.0.0.1:{ports[2]}';control_key=secrets.token_urlsafe(32);project='golf-email-proof-'+secrets.token_hex(5)
    occupied=[]
    for identifier in run('docker','network','ls','-q').splitlines():
        row=json.loads(run('docker','network','inspect',identifier))[0]
        occupied += [ipaddress.ip_network(v['Subnet']) for v in (row.get('IPAM',{}).get('Config') or []) if v.get('Subnet')]
    subnet=next((ipaddress.ip_network(f'172.{second}.{third}.0/24') for second in range(16,32) for third in range(32,224) if not any(ipaddress.ip_network(f'172.{second}.{third}.0/24').overlaps(v) for v in occupied if v.version==4)),None);assert subnet
    record(project=project,receiverScope='owned internal verified-TLS465 + secret-protected loopback control')
    receiver_ip=str(subnet.network_address+10);actors={};bearers=[];started=False;passed=False;original=None;cleanup_errors=[]
    with tempfile.TemporaryDirectory(prefix=project+'-') as tmp:
        directory=Path(tmp);directory.chmod(0o700);fixture=directory/'fixture';fixture.mkdir(mode=0o700)
        for path,text in [('sink.py',SINK),('sink.json',json.dumps({'controlKey':control_key,'golf':smoke.GOLF})),('ca.conf',CA_CONFIG),('extensions',SERVER_EXTENSIONS)]:private_write(fixture/path,text)
        stage('owned certificate authority and local verified-TLS receiver')
        run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(fixture/'ca.conf'),'-keyout',str(fixture/'ca.key'),'-out',str(fixture/'ca.crt'))
        run('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=receiver.golf.test','-keyout',str(fixture/'server.key'),'-out',str(fixture/'server.csr'))
        run('openssl','x509','-req','-days','1','-in',str(fixture/'server.csr'),'-CA',str(fixture/'ca.crt'),'-CAkey',str(fixture/'ca.key'),'-CAcreateserial','-extfile',str(fixture/'extensions'),'-out',str(fixture/'server.crt'))
        for name in ('ca.key','server.key'):(fixture/name).chmod(0o600)
        (fixture/'ca.crt').chmod(0o644)
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')};values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_PUSH_CI_ENABLED='false')
        policy=json.dumps([{'host':'receiver.golf.test','port':465,'tls_mode':'implicit','ips':[receiver_ip+'/32']}]);private_write(directory/'proof.env',''.join(k+'='+v+'\n' for k,v in values.items()))
        private_write(directory/'proof.yaml',f'''services:
  postgres:
    image: {images['postgres']}
    pull_policy: never
    mem_limit: 768m
    cpus: 1
  gitea:
    image: {images['native']}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
    mem_limit: 512m
    cpus: 1
  golf:
    image: {images['golf']}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
    environment:
      SSL_CERT_FILE: /proof-ca.crt
      GOLF_EMAIL_EGRESS_POLICY: '{policy}'
    volumes: ["{fixture/'ca.crt'}:/proof-ca.crt:ro"]
    networks: [default, proofsink]
    mem_limit: 384m
    cpus: 1
  email-worker:
    image: {images['golf']}
    pull_policy: never
    command: [email-worker]
    environment:
      GOLF_PUBLIC_URL: {smoke.GOLF}
      GOLF_ALLOW_INSECURE_COOKIES: 'true'
      GOLF_ENCRYPTION_KEY: {values['GOLF_ENCRYPTION_KEY']}
      DATABASE_URL: postgres://golf:{values['GOLF_DB_PASSWORD']}@postgres:5432/golf?sslmode=disable
      GITEA_URL: http://gitea:3000
      SSL_CERT_FILE: /proof-ca.crt
      GOLF_EMAIL_EGRESS_POLICY: '{policy}'
    volumes: ["{fixture/'ca.crt'}:/proof-ca.crt:ro"]
    networks: [default, proofsink]
    read_only: true
    tmpfs: ["/tmp:size=16777216,mode=1777"]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 256m
    cpus: 0.5
    pids_limit: 64
    stop_grace_period: 20s
    depends_on:
      golf: {{condition: service_started}}
      postgres: {{condition: service_healthy}}
  receiver:
    image: {images['sink']}
    pull_policy: never
    user: "{os.getuid()}:{os.getgid()}"
    entrypoint: [python3, /fixture/sink.py]
    ports: ["127.0.0.1:{ports[2]}:8765"]
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    sysctls: {{net.ipv4.ip_unprivileged_port_start: '0'}}
    tmpfs: ["/tmp:size=16777216,mode=1777"]
    mem_limit: 64m
    cpus: 0.25
    pids_limit: 32
    volumes: ["{fixture}:/fixture:ro"]
    networks:
      default: {{}}
      proofsink:
        ipv4_address: {receiver_ip}
        aliases: [receiver.golf.test]
networks:
  proofsink:
    internal: true
    ipam:
      config: [{{subnet: {subnet}}}]
''')
        compose=['docker','compose','--project-directory',str(ROOT),'-p',project,'--env-file',str(directory/'proof.env'),'-f',str(ROOT/'compose.yaml'),'-f',str(directory/'proof.yaml')]
        def command(*args,payload=None,timeout=120):return run(*compose,*args,payload=payload,timeout=timeout)
        def admin(*args):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*args)
        def call(role,method,body=None,expected=200,headers=None):return checked_rpc(actors[role]['session'],SERVICE+method,body,expected,headers)
        def rpc(role,method,body=None,expected=200,headers=None):return checked_rpc(actors[role]['session'],method,body,expected,headers)
        def control(path,body=None):
            req=urllib.request.Request(control_url+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+control_key,'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=5) as response:
                raw=response.read((1<<20)+1);assert len(raw)<=1<<20;return json.loads(raw)
        def records():return [receiver_receipt(v) for v in control('/receipts')['receipts']]
        def until(fn,seconds=90,transient=False):
            deadline=time.monotonic()+seconds
            while time.monotonic()<deadline:
                try:found=fn()
                except (urllib.error.URLError,OSError):
                    if not transient:raise
                    found=None
                if found:return found
                time.sleep(.4)
            raise AssertionError('Bounded observation deadline exceeded')
        def scalar(query):
            assert query.startswith('SELECT ') and ';' not in query
            value=command('exec','-T','postgres','psql','-U','postgres','-d','golf','-At','-v','ON_ERROR_STOP=1','-c',query);assert re.fullmatch(r'[0-9]+',value);return int(value)
        def runtime():
            result={}
            for service in ('golf','email-worker'):
                cid=command('ps','-aq',service);assert re.fullmatch(r'[a-f0-9]{12,64}',cid)
                row=json.loads(run('docker','inspect',cid))[0];assert row['Image']==images['golf']
                result[service]={'containerId':cid,'imageReference':row['Config']['Image'],'ociImageId':row['Image'],'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash']}
            return result
        def own(role):
            state=call(role,'GetOwnEmailNotifications')['state'];assert state['loginEmail']==actors[role]['email'] and state['nativeUserId']==actors[role]['id'] and all(positive(state[k]) for k in ('userId','nativeUserId','localAccountId','credentialVersion')) and positive(state['contactVersion'],True) and positive(state['preferenceVersion'],True);return state
        def history(role,selected=None):
            response=call(role,'ListOwnEmailDeliveries',{'page':{'limit':100},**({'target':selected} if selected else {})});assert response['userId']==own(role)['userId'] and response.get('target')==selected and not response.get('page',{}).get('nextPage');rows=response.get('deliveries',[])
            for row in rows:
                assert str(uuid.UUID(row['id']))==row['id'] and row['state'] in ('queued','sending','retrying','accepted','failed','cancelled','suppressed')
                assert positive(row['contactVersion']) and 0<=row.get('attempts',0)<=6 and 0<=row.get('smtpStatus',0)<=599
                assert row['kind'] in ('verification','activity') and row['eventTopic'] in ('verification','source','issues','pulls','actions')
                if row.get('subscriptionId'):assert str(uuid.UUID(row['subscriptionId']))==row['subscriptionId'] and positive(row['subscriptionVersion'])
            return rows
        def terminal(role,identifier,selected=None):return until(lambda:next((v for v in history(role,selected) if v['id']==identifier and v['state'] in ('accepted','failed','cancelled','suppressed')),None))
        def subscribe(role,selected,enabled=True,previous=None):
            state=own(role);body={'target':selected,'id':previous['id'] if previous else str(uuid.uuid4()),'expectedVersion':previous['version'] if previous else '0','expectedContactVersion':state['contactVersion'],'eventTopics':['issues'],'enabled':enabled,'authorizeBackground':enabled};out=call(role,'SaveRepositoryEmailSubscription',body);assert out['target']==selected and out['subscription']['id']==body['id'] and out['subscription']['version']==str(int(body['expectedVersion'])+1) and out['subscription']['contactVersion']==state['contactVersion'] and out['subscription']['eventTopics']==body['eventTopics'] and out['subscription'].get('enabled',False)==enabled;return out['subscription']
        def activity():
            result=rpc('owner','RepositoryService/CreateIssue',{'repository':target['repository'],'repositoryId':target['repositoryId'],'title':'Owned category event','body':'PRIVATE_EMAIL_QUALIFIER_BODY','idempotencyKey':str(uuid.uuid4())});assert result['mutation']['state']=='ISSUE_MUTATION_STATE_SUCCEEDED'
        def pending(role):return until(lambda:next((v for v in history(role,target) if v['state']=='queued'),None))
        try:
            stage('fresh core and local TLS receiver; worker initially stopped');started=True;command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf','receiver',timeout=180);smoke.ready();assert smoke.provider('','GET','version')['version']=='1.27.3'
            until(lambda:control('/receipts'),transient=True)
            stage('ordinary native actors and explicit managed local enrollment')
            for role in ('operator','owner','reader','outsider',*(('uidark','uilight') if args.ui else ())):
                name='em-'+project.rsplit('-',1)[-1]+'-'+role;email=name+'@example.invalid';password='Owned SMTP '+secrets.token_urlsafe(24)
                actors[role]={'name':name,'email':email,'password':password,'session':smoke.client(),'nativeCreated':False,'enrolled':False}
                admin('create','--username',name,'--email',email,'--random-password','--must-change-password=false');actors[role]['nativeCreated']=True
                token=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:repository,write:issue','--raw');actors[role]['token']=token
                result=json.loads(command('exec','-T','golf','golf','local-account','create',payload={'username':name,'email':email,'password':password,'forge_token':token,'is_instance_admin':role=='operator'}));assert result['state']=='complete';actors[role]['enrolled']=True
                response=rpc(role,'SessionService/LoginWithPassword',{'username':email,'password':password});actors[role]['id']=response['user']['id'];assert positive(actors[role]['id'])
            record(nativeActorIds={role:a['id'] for role,a in actors.items()})
            control('/recipients',{'recipients':[a['email'] for a in actors.values()]})
            native=smoke.provider(actors['owner']['token'],'POST','user/repos',{'name':'email-proof','private':True,'auto_init':True},201);smoke.wait_for_push(actors['owner']['token'],native['full_name']);route='repos/'+native['full_name'];repository={'owner':native['owner']['login'],'name':native['name']};target={'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id'])}
            for role in ('reader',*(('uidark','uilight') if args.ui else ())):smoke.provider(actors['owner']['token'],'PUT',route+'/collaborators/'+actors[role]['name'],{'permission':'read'},204)
            record(repositoryTarget=target)
            access=rpc('reader','RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access'];assert access['repositoryId']==target['repositoryId'] and access['ownerId']==target['ownerId'] and access['currentPermission']=='read'
            stage('explicit SMTP version/activation and metadata-only inventory')
            transport_id=str(uuid.uuid4());body={'id':transport_id,'expectedVersion':'0','name':'Owned TLS SMTP','host':'receiver.golf.test','port':465,'tlsMode':'implicit','sender':'sender@example.invalid','currentPassword':actors['operator']['password']}
            call('reader','SaveEmailTransport',body,403);saved=call('operator','SaveEmailTransport',body)['transport'];assert saved['id']==transport_id and saved['version']=='1' and not saved.get('active') and saved['hasCredential']
            activated=call('operator','ActivateEmailTransport',{'id':transport_id,'version':'1','expectedActivationGeneration':'0','currentPassword':actors['operator']['password']});assert activated['transport']['active'] and activated['activationGeneration']=='1'
            inventory=call('operator','ListEmailTransports');assert len(inventory['transports'])==1 and not any(k in inventory['transports'][0] for k in ('sender','username','password'))
            call('reader','GetRepositoryEmailSubscription',{'target':{**target,'repositoryId':'9223372036854775807'}},404);call('outsider','GetRepositoryEmailSubscription',{'target':target},404);call('reader','GetOwnEmailNotifications',expected=403,headers={'Origin':'https://other.invalid'})
            delegation=rpc('reader','ApiCredentialService/CreateApiCredential',{'label':'SMTP no delegation','lifetimeSeconds':600});bearers.append(('reader',delegation['credential']['id']));checked_rpc(smoke.client(),SERVICE+'GetOwnEmailNotifications',expected=403,headers={'Authorization':'Bearer '+delegation['token']});rpc('reader','ApiCredentialService/RevokeApiCredential',{'credentialId':delegation['credential']['id']});bearers.clear()
            stage('one-time own mailbox verification; queued metadata before real worker')
            state=own('reader');operation=str(uuid.uuid4());verification=call('reader','RequestEmailVerification',{'operationId':operation,'expectedContactVersion':state['contactVersion']});assert verification['challengeId']==operation and verification['deliveryId']==operation and verification['acceptedContactVersion']=='1' and not records()
            assert call('reader','RequestEmailVerification',{'operationId':operation,'expectedContactVersion':state['contactVersion']})['deliveryId']==operation
            command('create','--no-build','--pull','never','email-worker');baseline=runtime();record(runtimeBefore=baseline);command('start','email-worker');accepted=terminal('reader',operation);assert accepted['state']=='accepted' and accepted['smtpStatus']==250 and accepted['attempts']==1
            code=control('/code/'+operation)['code'];assert re.fullmatch(r'[0-9]{8}',code);wrong='00000000' if code!='00000000' else '11111111';call('reader','ConfirmEmailVerification',{'challengeId':operation,'expectedContactVersion':'1','code':wrong},400);confirmed=call('reader','ConfirmEmailVerification',{'challengeId':operation,'expectedContactVersion':'1','code':code})['state'];del code,wrong;assert confirmed['verified'] and not confirmed.get('enabled')
            call('reader','ConfirmEmailVerification',{'challengeId':operation,'expectedContactVersion':'1','code':'00000000'},400)
            call('reader','SaveOwnEmailPreference',{'expectedContactVersion':'1','expectedPreferenceVersion':confirmed['preferenceVersion'],'enabled':True,'authorizeBackground':True});sub=subscribe('reader',target)
            stage('actual committed activity and approved logout delivery; private body excluded')
            command('stop','email-worker');activity();queued=pending('reader');before=len(records());rpc('reader','SessionService/Logout');command('start','email-worker')
            until(lambda:len(records())==before+1);checked_rpc(actors['reader']['session'],SERVICE+'GetOwnEmailNotifications',expected=401);rpc('reader','SessionService/LoginWithPassword',{'username':actors['reader']['email'],'password':actors['reader']['password']});first=terminal('reader',queued['id'],target);assert first['state']=='accepted' and first['smtpStatus']==250
            stable=len(records());command('restart','golf','email-worker');smoke.ready();assert history('reader',target)[0]['id']==first['id'];time.sleep(2);assert len(records())==stable
            for mode in ('retry_once','drop_once'):
                stage('actual SMTP '+mode+' preserves frozen Message-ID/body')
                command('stop','email-worker');activity();queued=pending('reader');control('/mode',{'id':queued['id'],'mode':mode});command('start','email-worker');done=terminal('reader',queued['id'],target);copies=[v for v in records() if v['deliveryId']==queued['id']];assert done['state']=='accepted' and done['attempts']==2 and len(copies)==2 and copies[0]['bodySha256']==copies[1]['bodySha256'];assert done.get('possibleDuplicate',False)==(mode=='drop_once')
            stage('explicit redelivery and GET-inert/POST unsubscribe')
            original_delivery=history('reader',target)[0];redelivery=str(uuid.uuid4());intent={'deliveryId':original_delivery['id'],'expectedContactVersion':own('reader')['contactVersion'],'operationId':redelivery};redone=call('reader','RedeliverOwnEmail',intent)['delivery'];assert redone['id']==redelivery and redone['possibleDuplicate'];assert call('reader','RedeliverOwnEmail',intent)['delivery']['id']==redelivery;assert terminal('reader',redelivery,target)['state']=='accepted'
            # The opaque capability is transient receiver RAM only; no stored
            # message/code/link is extracted from Golf's encrypted tables.
            link=control('/unsubscribe/'+redelivery)['url'];parsed=urllib.parse.urlsplit(link);assert parsed.scheme=='http' and parsed.netloc==urllib.parse.urlsplit(smoke.GOLF).netloc and parsed.path=='/notifications/unsubscribe'
            token=urllib.parse.parse_qs(parsed.query)['token'][0];assert len(token)==43 and len(base64.urlsafe_b64decode(token+'='))==32
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args):raise AssertionError('Unsubscribe redirect is forbidden')
            unsubscribe_client=urllib.request.build_opener(NoRedirect)
            command('stop','email-worker');activity();unsubscribe_pending=pending('reader');before=control('/receipts')
            with unsubscribe_client.open(link,timeout=10) as response:html=response.read(16385);assert response.status==200 and len(html)<=16384 and response.headers.get('Cache-Control')=='no-store' and b'<form method="post"' in html
            current=call('reader','GetRepositoryEmailSubscription',{'target':target})['subscription'];assert current['enabled'] and current['version']==sub['version']
            def unsubscribe_post():
                req=urllib.request.Request(smoke.GOLF+'/notifications/unsubscribe',data=urllib.parse.urlencode({'token':token}).encode(),method='POST',headers={'Content-Type':'application/x-www-form-urlencoded'})
                with unsubscribe_client.open(req,timeout=10) as response:body=response.read(4097);assert response.status==200 and len(body)<=4096 and response.headers.get('Cache-Control')=='no-store' and not response.headers.get('Location')
            unsubscribe_post();current=call('reader','GetRepositoryEmailSubscription',{'target':target})['subscription'];assert not current.get('enabled') and current['authorizationState']=='unsubscribed'
            command('start','email-worker');assert terminal('reader',unsubscribe_pending['id'],target)['state']=='cancelled' and control('/receipts')==before
            sub=subscribe('reader',target,previous=current);unsubscribe_post();assert call('reader','GetRepositoryEmailSubscription',{'target':target})['subscription']['enabled'];del token,link,html
            record(unsubscribeGetInert=True,unsubscribeExplicitPost=True,unsubscribePendingNoReceiverBytes=True,oldUnsubscribeCannotDisableNewVersion=True)
            # Build a current-version redelivery receipt for later native-private
            # replay denial; the earlier version is already invalidated by consent.
            command('stop','email-worker');activity();fresh=pending('reader');command('start','email-worker');assert terminal('reader',fresh['id'],target)['state']=='accepted'
            intent={'deliveryId':fresh['id'],'expectedContactVersion':own('reader')['contactVersion'],'operationId':str(uuid.uuid4())};current_redelivery=call('reader','RedeliverOwnEmail',intent)['delivery'];assert terminal('reader',current_redelivery['id'],target)['state']=='accepted'
            if args.ui:
                stage('actual account/repository/administrator browser views and privacy')
                config={'golf':smoke.GOLF,'native':smoke.GITEA,'control':control_url,'controlKey':control_key,'repository':native['full_name'],'target':target,'ownerToken':actors['owner']['token'],'operator':{k:actors['operator'][k] for k in ('email','password')},'fixtures':{theme:{k:actors['ui'+theme][k] for k in ('email','password','name','id')} for theme in ('dark','light')},'output':str(OUTPUT),'runtime':baseline,'paths':{'account':ACCOUNT_PATH,'repository':REPOSITORY_PATH.format(**repository),'admin':ADMIN_PATH}}
                result=subprocess.run(['node',str(ROOT/'scripts/email-notifications-browser.mjs')],cwd=ROOT,env=env,input=json.dumps(config).encode(),capture_output=True,timeout=420);assert len(result.stdout)<=65536 and len(result.stderr)<=65536;browser=json.loads((OUTPUT/'browser-manifest.json').read_text());record(browser=browser);assert result.returncode==0 and browser['status']=='passed_cleanup_pending' and len(browser['captures'])==12
            stage('current native access removal cancels queued mail with zero receiver bytes')
            command('stop','email-worker');activity();queued=pending('reader');smoke.provider(actors['owner']['token'],'DELETE',route+'/collaborators/'+actors['reader']['name'],expected=204);before=control('/receipts');command('start','email-worker');until(lambda:scalar("SELECT count(*) FROM golf_email_deliveries WHERE id='"+queued['id']+"' AND state='cancelled'")==1);time.sleep(2);after=control('/receipts');assert after==before
            call('reader','GetRepositoryEmailSubscription',{'target':target},404);call('reader','ListOwnEmailDeliveries',{'target':target},404);call('reader','RedeliverOwnEmail',intent,404)
            stage('local credential disable cancels pending verified subscription without SMTP')
            command('stop','email-worker');smoke.provider(actors['owner']['token'],'PUT',route+'/collaborators/'+actors['reader']['name'],{'permission':'read'},204);current=call('reader','GetRepositoryEmailSubscription',{'target':target})['subscription'];sub=subscribe('reader',target,previous=current);activity();queued=pending('reader');disabled=json.loads(command('exec','-T','golf','golf','local-account','disable',payload={'username':actors['reader']['name']}));assert disabled['result']['disabled'];checked_rpc(actors['reader']['session'],SERVICE+'GetOwnEmailNotifications',expected=401);before=control('/receipts');command('start','email-worker');until(lambda:scalar("SELECT count(*) FROM golf_email_deliveries WHERE id='"+queued['id']+"' AND state='cancelled'")==1);time.sleep(2);assert control('/receipts')==before
            assert runtime()==baseline;record(runtimeAfter=runtime(),receiverReceipts=records(),mailCodesAndBodiesPersisted=False,verifiedOwnMailbox=True,logoutConsentContinued=True,restartNoResend=True,temporaryRetry=True,uncertainDataAckDuplicate=True,currentNativeRevocationNoReceiverBytes=True,localDisableNoReceiverBytes=True,privateActivityBodyExcluded=True,sqlAckLoss='source_fixture_only',cloudflare='not_exercised',inboxDelivery='not_claimed');passed=True
        except Exception as error:
            original=error;frames=traceback.extract_tb(error.__traceback__);record(originalFailureType=type(error).__name__,originalFailureLine=frames[-1].lineno,originalFailureStage=STAGE)
        finally:
            print('CHECK: owned fixture cleanup',flush=True)
            if started:
                for role,identifier in bearers:
                    try:rpc(role,'ApiCredentialService/RevokeApiCredential',{'credentialId':identifier})
                    except Exception:cleanup_errors.append('bearer revoke')
                for actor in actors.values():
                    try:checked_rpc(actor['session'],'SessionService/Logout')
                    except Exception:pass
                    if actor.get('enrolled'):
                        try:result=json.loads(command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']}));assert result['result']['disabled']
                        except Exception:cleanup_errors.append('managed disable')
                    if actor.get('nativeCreated'):
                        try:admin('delete','--username',actor['name'],'--purge')
                        except Exception:cleanup_errors.append('native purge')
                try:command('down','--volumes','--remove-orphans',timeout=120)
                except Exception:cleanup_errors.append('compose teardown')
                for resource,verb in [('ps','-aq'),('volume','ls'),('network','ls')]:
                    try:
                        args=['docker',resource,verb] if resource=='ps' else ['docker',resource,verb,'-q'];assert not run(*args,'--filter','label=com.docker.compose.project='+project)
                    except Exception:cleanup_errors.append(resource+' absence')
            smoke.GOLF,smoke.GITEA=previous;record(cleanup='passed' if not cleanup_errors else 'failed',cleanupFailures=cleanup_errors,status='passed' if passed and not cleanup_errors else 'failed')
        if original:raise original
        assert passed and not cleanup_errors,'Owned cleanup incomplete; fixed categories recorded'
    print('PASS: owned verified mailbox, real local TLS SMTP acceptance/retry/privacy and cleanup; no external providers or retained stack modified',flush=True)


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=traceback.extract_tb(error.__traceback__);record(status='failed',failureType=type(error).__name__,failureLine=frames[-1].lineno,failureStage=PROOF.get('originalFailureStage',STAGE));print('FAIL: SMTP qualification at '+PROOF.get('originalFailureStage',STAGE)+'; '+type(error).__name__+'; safe line '+str(frames[-1].lineno)+'; private diagnostics withheld',file=sys.stderr);sys.exit(1)

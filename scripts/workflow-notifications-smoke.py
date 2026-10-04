#!/usr/bin/env python3
"""Prepared056 workflow terminal SMTP/HMAC qualification; root runs resources.

Fresh cached-image Compose only, supported APIs/CLI, real shell workflow producer,
RAM-only owned TLS receivers and read-only Golf metadata SQL. No build/pull,
provider inference, native database/file edits or retained changes. --self-check
is pure. A bounded operator seed window exposes only the exact fresh Docker
daemon CID/project/image; the helper independently verifies its admitted image.
Operator seed provenance is separate; no zero-registry-usage claim is inferred.
No lost/timeout/CD/inbox/Cloudflare/recovery/full-settings readiness claim.
"""
import argparse
import ast
import base64
import datetime
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import smoke
import native_qualification_proxy as native_proxy

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

email=load('workflow_smtp_helpers',ROOT/'scripts/email-notifications-smoke.py')
webhooks=load('workflow_hmac_helpers',ROOT/'scripts/outbound-webhook-smoke.py')
helpers=load('workflow_stack_helpers',ROOT/'scripts/observability-smoke.py')
rules=load('workflow_native_helpers',ROOT/'scripts/repository-rule-mutations-smoke.py')
JOB_IMAGE='alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
DIND='docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
MODES={role:'WORKFLOW_NOTIFICATION_MODE_'+role.upper() for role in ('activity','completed','failures')}
STAGE,OUTPUT='arguments',None
PROOF={'status':'prepared_not_run','cleanup':'not_created','scope':'Real bounded manual shell workflow outcomes and committed056 SMTP/HMAC outboxes; no inbox delivery or full Actions/settings readiness.',
       'remaining':['lost and timed-out real producer states','native automatic push producer','notification unsubscribe/revocation/scale/recovery acceptance','maintained-engine notification runtime','CD/Cloudflare/inbox delivery']}

# Reuse the qualified SMTP framing/control implementation. These exact guarded
# additions keep raw mail, challenge codes, endpoints and keys only in RAM.
MAIL_CAPTURE=r'''
    if not challenge:
     if text.startswith('Golf workflow outcome: '):
      facts={name:re.search(r'^'+label+r': (.+)$',text,re.M).group(1) for name,label in [('label','Golf workflow outcome'),('runId','Run'),('attemptId','Attempt'),('repositoryId','Repository ID'),('ownerId','Owner ID')]}
      link=next(line for line in text.splitlines() if '/actions/runs/' in line)
      assert facts['label'] in ('Succeeded','Failed','Timed out','Cancelled','Outcome unconfirmed (lost)') and link.startswith(cfg['golf']+'/')
      facts.update(deliveryId=delivery,role=cfg['roles'][recipient],link=link,truthfulLost=('execution outcome is unconfirmed' in text),truthfulCancellation=('does not prove immediate process cleanup' in text))
      with lock:assert len(mailfacts)<2000;mailfacts.append(facts)
     else:
      with lock:assert len(mailfacts)<2000;mailfacts.append({'deliveryId':delivery,'role':cfg['roles'][recipient],'activity':True})
'''
WEB_RECEIVER=r'''
class Webhook(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  try:
   assert self.path in ('/workflow-proof/activity','/workflow-proof/completed','/workflow-proof/failures');role=self.path.rsplit('/',1)[-1]
   size=int(self.headers.get('Content-Length','0'));assert 0<size<=16384;body=self.rfile.read(size);assert len(body)==size
   event=self.headers['X-Golf-Event-ID'];delivery=self.headers['X-Golf-Delivery-ID'];stamp=self.headers['X-Golf-Timestamp'];signature=self.headers['X-Golf-Signature-256']
   assert str(__import__('uuid').UUID(delivery))==delivery and str(int(stamp))==stamp and abs(time.time()-int(stamp))<=60
   expected='sha256='+hmac.new(cfg['keys'][role].encode(),stamp.encode()+b'\n'+event.encode()+b'\n'+body,hashlib.sha256).hexdigest();assert hmac.compare_digest(expected,signature)
   parsed=json.loads(body);assert parsed['schema']=='golf.webhook.v1' and parsed['event_id']==event
   with lock:
    assert len(webfacts)<2000;attempt=1+sum(v['deliveryId']==delivery for v in webfacts);mode=webmodes.get(delivery,'accept')
    webfacts.append({'role':role,'deliveryId':delivery,'eventId':event,'timestamp':stamp,'signature':signature,'bodyBase64':__import__('base64').b64encode(body).decode(),'requestIndex':attempt,'mode':mode})
   if mode=='drop' and attempt==1:self.connection.shutdown(socket.SHUT_RDWR);return
   self.send_response(503 if mode=='retry' and attempt==1 else 204)
   if mode=='retry' and attempt==1:self.send_header('Retry-After','1')
   self.end_headers()
  except Exception:self.send_response(400);self.end_headers()
web=ThreadingHTTPServer(('0.0.0.0',443),Webhook);web.daemon_threads=True
webtls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);webtls.minimum_version=ssl.TLSVersion.TLSv1_2;webtls.load_cert_chain('/fixture/server.crt','/fixture/server.key');web.socket=webtls.wrap_socket(web.socket,server_side=True)
threading.Thread(target=web.serve_forever,daemon=True).start()
'''

def sink_source():
    source=email.SINK
    assert source.count('class Control(BaseHTTPRequestHandler):')==1 and source.count('    del body,text,msg,challenge')==1
    source=source.replace('class SMTP(StreamRequestHandler):','mailfacts=[];webfacts=[];webmodes={}\nclass SMTP(StreamRequestHandler):',1)
    source=source.replace('    del body,text,msg,challenge',MAIL_CAPTURE+'    del body,text,msg,challenge',1)
    source=source.replace("   if self.command=='GET' and self.path=='/receipts':", "   if self.command=='GET' and self.path=='/workflow-facts':out={'mail':list(mailfacts),'webhooks':list(webfacts)}\n   elif self.command=='GET' and self.path=='/receipts':",1)
    source=source.replace("    if self.path=='/recipients':", "    if self.path=='/web-mode':assert data['mode'] in ('accept','retry','drop');webmodes[data['id']]=data['mode'];out={'configured':True}\n    elif self.path=='/recipients':",1)
    source=source.replace("threading.Thread(target=smtp.serve_forever,daemon=True).start();",WEB_RECEIVER+"\nthreading.Thread(target=smtp.serve_forever,daemon=True).start();",1)
    return source


def record(**values):
    PROOF.update(values)
    if OUTPUT:
        path=OUTPUT/'manifest.json.tmp'
        with path.open('w') as f:path.chmod(0o600);json.dump(PROOF,f,indent=2,sort_keys=True);f.write('\n')
        path.replace(OUTPUT/'manifest.json')

def stage(value):
    global STAGE
    STAGE=value;record(stage=value);print('CHECK: '+value,flush=True)

def network_subnets(row):
    # Host/none drivers legitimately report Config:null.
    return [ipaddress.ip_network(v['Subnet']) for v in ((row.get('IPAM') or {}).get('Config') or []) if v.get('Subnet')]

def closed_failure(error):
    allowed_types={'AssertionError','TypeError','ValueError','KeyError','IndexError','RuntimeError','TimeoutError','TimeoutExpired','HTTPError','URLError','ConnectionError','FileNotFoundError','PermissionError','JSONDecodeError','OSError','StopIteration'}
    allowed_files={Path(__file__).name,'email-notifications-smoke.py','outbound-webhook-smoke.py','observability-smoke.py','repository-rule-mutations-smoke.py','native_qualification_proxy.py','smoke.py'}
    kind=type(error).__name__;frames=[];trace=error.__traceback__
    while trace:
        name=Path(trace.tb_frame.f_code.co_filename).name
        frames.append({'file':name if name in allowed_files else 'dependency','line':trace.tb_lineno})
        trace=trace.tb_next
    return {'failureType':kind if kind in allowed_types else 'UnexpectedError','failureFrames':frames[-8:]}

def event_receipt(row,keys,target,runs):
    assert set(row)=={'role','deliveryId','eventId','timestamp','signature','bodyBase64','requestIndex','mode'}
    assert row['role'] in MODES and str(uuid.UUID(row['deliveryId']))==row['deliveryId']
    assert row['mode'] in ('accept','retry','drop') and 1<=row['requestIndex']<=6
    raw=base64.b64decode(row['bodyBase64'],validate=True);assert 0<len(raw)<=16384
    assert hmac.compare_digest(row['signature'],webhooks.signed(keys[row['role']],row['timestamp'],row['eventId'],raw))
    value=json.loads(raw);assert value['schema']=='golf.webhook.v1' and value['event_id']==row['eventId'] and value['repository_id']==target['repositoryId']
    if value['event']=='workflow.run.terminal':
        assert set(value)=={'schema','event','producer','event_id','repository_id','owner_id','run_id','attempt_id','state','occurred_at'}
        run=runs[value['run_id']];assert value['producer']=='golf.workflow_notification_events' and value['event_id']=='workflow-terminal:'+run['id']
        assert value['owner_id']==target['ownerId'] and value['state']==run['state'].removeprefix('WORKFLOW_RUN_STATE_').lower()
        assert value['attempt_id']==(run.get('attemptId') or None) and row['role']!='activity'
        assert row['role']=='completed' or value['state'] in ('failed','timed_out')
    else:
        assert row['role']=='activity' and value['event']=='repository.activity.actions' and value['producer']=='golf.repository_activity' and row['eventId'].startswith('activity:')
        assert set(value)=={'schema','event','producer','event_id','repository_id','occurred_at'}
    return {k:row[k] for k in ('role','deliveryId','eventId','requestIndex','mode')}|{'bodyBytes':len(raw),'bodySha256':hashlib.sha256(raw).hexdigest(),'signatureVerified':True}

def self_check():
    ast.parse(sink_source())
    assert network_subnets({'IPAM':{'Config':None}})==[] and network_subnets({'IPAM':None})==[] and network_subnets({})==[]
    assert network_subnets({'IPAM':{'Config':[{'Subnet':'172.20.1.0/24'},{}]}})==[ipaddress.ip_network('172.20.1.0/24')]
    try:raise TypeError('PRIVATE_BODY_DIAGNOSTIC')
    except TypeError as error:
        diagnostic=closed_failure(error);assert diagnostic['failureType']=='TypeError' and diagnostic['failureFrames'] and 'PRIVATE_BODY_DIAGNOSTIC' not in json.dumps(diagnostic) and all(set(v)=={'file','line'} and type(v['line']) is int for v in diagnostic['failureFrames'])
    source=(ROOT/'api/golf/v1/golf.proto').read_text();assert all(mode+' =' in source for mode in MODES.values())
    target={'repositoryId':'9007199254740993','ownerId':'42'};run={'id':str(uuid.uuid4()),'state':'WORKFLOW_RUN_STATE_FAILED','attemptId':'a'*32}
    payload={'schema':'golf.webhook.v1','event':'workflow.run.terminal','producer':'golf.workflow_notification_events','event_id':'workflow-terminal:'+run['id'],'repository_id':target['repositoryId'],'owner_id':'42','run_id':run['id'],'attempt_id':run['attemptId'],'state':'failed','occurred_at':'2026-10-04T12:00:00Z'}
    keys={role:'K'*32 for role in MODES};raw=json.dumps(payload).encode();row={'role':'failures','deliveryId':str(uuid.uuid4()),'eventId':payload['event_id'],'timestamp':'1791100000','signature':webhooks.signed(keys['failures'],'1791100000',payload['event_id'],raw),'bodyBase64':base64.b64encode(raw).decode(),'requestIndex':1,'mode':'accept'}
    event_receipt(row,keys,target,{run['id']:run})
    for field,value in [('role','activity'),('signature','sha256='+'0'*64),('eventId','foreign')]:
        try:event_receipt(row|{field:value},keys,target,{run['id']:run})
        except (AssertionError,KeyError):pass
        else:raise AssertionError('False terminal receipt accepted')
    changed=payload|{'state':'cancelled'};body=json.dumps(changed).encode();bad=row|{'signature':webhooks.signed(keys['failures'],row['timestamp'],row['eventId'],body),'bodyBase64':base64.b64encode(body).decode()}
    try:event_receipt(bad,keys,target,{run['id']:run|{'state':'WORKFLOW_RUN_STATE_CANCELLED'}})
    except AssertionError:pass
    else:raise AssertionError('Failure-only cancellation delivery accepted')
    assert 'write_text' not in sink_source() and 'bodyBase64' not in json.dumps(event_receipt(row,keys,target,{run['id']:run}))
    print('PASS: pure combined TLS sink AST/HMAC immutable terminal+filter counterexamples, no body/credential evidence; no resources')


def main():
    global OUTPUT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true');parser.add_argument('--ui',action='store_true',help='Optional single actual manual ACK-loss dispatch + four same-original inspection captures; requires the root browser helper')
    for name in ('image','runner-image','sink-image','source-revision','expected-core-sha256','expected-runner-sha256'):parser.add_argument('--'+name)
    parser.add_argument('--proxy-binary',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--stack-root',type=Path,default=ROOT);parser.add_argument('--seed-wait-seconds',type=int,default=300)
    args=parser.parse_args()
    if args.self_check:self_check();return
    required=('image','runner_image','sink_image','source_revision','expected_core_sha256','expected_runner_sha256','proxy_binary','output')
    if not all(getattr(args,key) for key in required):parser.error('Exact core/runner/sink, source, binary hashes, proxy and fresh output are required')
    assert all(re.fullmatch(r'sha256:[a-f0-9]{64}',getattr(args,key)) for key in ('image','runner_image','sink_image'))
    assert re.fullmatch(r'[a-f0-9]{40}',args.source_revision) and all(re.fullmatch(r'[a-f0-9]{64}',getattr(args,key)) for key in ('expected_core_sha256','expected_runner_sha256')) and 1<=args.seed_wait_seconds<=600
    stack=args.stack_root.resolve();binary,binary_sha=rules.proxy_binary_receipt(args.proxy_binary)
    args.output.mkdir(mode=0o700,parents=True,exist_ok=False);OUTPUT=args.output.resolve();rules.ROOT=stack;rules.PROOF=PROOF;rules.OUTPUT=OUTPUT
    record(status='running',helperSha256=rules.file_sha256(Path(__file__),1<<20),runtimeSourceRevision=args.source_revision)
    env={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k not in ('DATABASE_URL','DOCKER_HOST','DOCKER_CONTEXT','SSL_CERT_FILE','SSL_CERT_DIR')};env['COMPOSE_DISABLE_ENV_FILE']='true'
    def run(*arguments,payload=None,timeout=180):
        result=subprocess.run(arguments,cwd=stack,env=env,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode==0 and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20,'Bounded private subprocess failed; output withheld'
        return result.stdout.decode().strip()
    stage('cached exact images and binary source receipts;2GiB reserve')
    images={}
    for role,ref in [('golf',args.image),('runner',args.runner_image),('sink',args.sink_image),('native',email.NATIVE_IMAGE),('postgres',email.PG_IMAGE),('daemon',DIND)]:
        row=json.loads(run('docker','image','inspect',ref))[0];images[role]=row['Id'];assert re.fullmatch(r'sha256:[a-f0-9]{64}',row['Id'])
        if role in ('golf','runner'):
            assert row['Id']==ref;revision=(row['Config'].get('Labels') or {}).get('org.opencontainers.image.revision');assert revision==args.source_revision
    binaries={}
    for role,name,digest in [('golf','golf',args.expected_core_sha256),('runner','golf-runner',args.expected_runner_sha256)]:
        value=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/usr/bin/sha256sum',images[role],'/usr/local/bin/'+name);assert value.split()==[digest,'/usr/local/bin/'+name];binaries[role]=digest
    free=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',images['golf'],'-Pk','/');assert int(free.splitlines()[-1].split()[3])>=2*1024*1024,'Require2GiB reserve'
    foreign_ids=run('docker','ps','-aq').splitlines()
    def foreign_snapshot():
        if not foreign_ids:return {}
        return {v['Id']:{'image':v['Image'],'status':v['State']['Status'],'running':v['State']['Running'],'startedAt':v['State']['StartedAt'],'restartCount':v['RestartCount']} for v in json.loads(run('docker','inspect',*foreign_ids))}
    foreign=set(foreign_ids);foreign_before=foreign_snapshot();project='golf-rules49-'+secrets.token_hex(5);ports=helpers.free_ports(4)
    previous=smoke.GOLF,smoke.GITEA;smoke.GOLF,smoke.GITEA='http://127.0.0.1:'+str(ports[0]),'http://127.0.0.1:'+str(ports[1])
    occupied=[]
    for cid in run('docker','network','ls','-q').splitlines():
        row=json.loads(run('docker','network','inspect',cid))[0];occupied.extend(network_subnets(row))
    subnet=next(ipaddress.ip_network(f'172.{a}.{b}.0/24') for a in range(16,32) for b in range(32,224) if not any(ipaddress.ip_network(f'172.{a}.{b}.0/24').overlaps(v) for v in occupied if v.version==4));sink_ip=str(subnet.network_address+10)
    actors={};keys={role:secrets.token_urlsafe(32) for role in MODES};control_key=secrets.token_urlsafe(32);started=False;passed=False;repos={};bootstrap_created=False
    record(project=project,proofKind='workflow-notifications056',images=images,binarySha256=binaries,helperGitRevision=run('git','rev-parse','HEAD'),proxyBinarySha256=binary_sha)
    with native_proxy.NativeProxy(ports[2],project) as proxy,tempfile.TemporaryDirectory(prefix=project+'-') as tmp:
        directory=Path(tmp);directory.chmod(0o700);fixture=directory/'fixture';fixture.mkdir(mode=0o700);rules.ACTIVE_PROXY=proxy
        roles={project+'-'+role+'@example.invalid':role for role in MODES}
        for name,value in [('sink.py',sink_source()),('sink.json',json.dumps({'golf':smoke.GOLF,'controlKey':control_key,'roles':roles,'keys':keys})),('ca.conf',email.CA_CONFIG),('extensions',email.SERVER_EXTENSIONS)]:helpers.private_write(fixture/name,value)
        run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(fixture/'ca.conf'),'-keyout',str(fixture/'ca.key'),'-out',str(fixture/'ca.crt'))
        run('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=receiver.golf.test','-keyout',str(fixture/'server.key'),'-out',str(fixture/'server.csr'))
        run('openssl','x509','-req','-days','1','-in',str(fixture/'server.csr'),'-CA',str(fixture/'ca.crt'),'-CAkey',str(fixture/'ca.key'),'-CAcreateserial','-extfile',str(fixture/'extensions'),'-out',str(fixture/'server.crt'));(fixture/'ca.crt').chmod(0o644)
        worker_key=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values={name:secrets.token_hex(24) for name in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')};values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_PUSH_CI_ENABLED='false',GOLF_RUNNER_KEYS=json.dumps({'local-docker':worker_key}),GOLF_RUNNER_KEY=worker_key,GOLF_RUNNER_IMAGES=json.dumps({'linux':JOB_IMAGE}),GOLF_RUNNER_APPROVED_IMAGES=json.dumps([JOB_IMAGE]),GOLF_RUNNER_JOB_IMAGE=JOB_IMAGE)
        smtp_policy=json.dumps([{'host':'receiver.golf.test','port':465,'tls_mode':'implicit','ips':[sink_ip+'/32']}]);web_policy=json.dumps([{'origin':'https://receiver.golf.test','addresses':[sink_ip],'path_prefix':'/workflow-proof'}])
        base_env={'GOLF_PUBLIC_URL':smoke.GOLF,'GOLF_ALLOW_INSECURE_COOKIES':'true','GOLF_ENCRYPTION_KEY':values['GOLF_ENCRYPTION_KEY'],'DATABASE_URL':'postgres://golf:'+values['GOLF_DB_PASSWORD']+'@postgres:5432/golf?sslmode=disable','GITEA_URL':'http://native-qualification-proxy:8081','SSL_CERT_FILE':'/proof-ca.crt','GOLF_EMAIL_EGRESS_POLICY':smtp_policy,'GOLF_WEBHOOK_EGRESS_POLICY':web_policy}
        worker=lambda command:{'image':images['golf'],'pull_policy':'never','command':[command],'environment':base_env,'volumes':[str(fixture/'ca.crt')+':/proof-ca.crt:ro'],'networks':['default','proofsink'],'read_only':True,'tmpfs':['/tmp:size=16777216,mode=1777'],'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'mem_limit':'256m','cpus':0.5,'pids_limit':64,'stop_grace_period':'20s'}
        overlay={'services':{'golf':{'image':images['golf'],'pull_policy':'never','environment':base_env,'volumes':[str(fixture/'ca.crt')+':/proof-ca.crt:ro'],'networks':['default','proofsink'],'mem_limit':'384m'},'postgres':{'image':images['postgres'],'pull_policy':'never','mem_limit':'768m'},'gitea':{'image':images['native'],'pull_policy':'never','mem_limit':'512m','environment':{'GITEA__server__ROOT_URL':smoke.GITEA+'/','GITEA__server__DISABLE_SSH':'true','GITEA__server__START_SSH_SERVER':'false'}},'email-worker':worker('email-worker'),'webhook-worker':worker('webhook-worker'),native_proxy.SERVICE_NAME:proxy.compose_service(images['golf'],binary),'runner':{'image':images['runner'],'pull_policy':'never'},'runner-daemon':{'image':images['daemon'],'pull_policy':'never','mem_limit':'1024m','cpus':2},'receiver':{'image':images['sink'],'pull_policy':'never','user':str(os.getuid())+':'+str(os.getgid()),'entrypoint':['python3','/fixture/sink.py'],'ports':['127.0.0.1:'+str(ports[3])+':8765'],'read_only':True,'tmpfs':['/tmp:size=16777216,mode=1777'],'volumes':[str(fixture)+':/fixture:ro'],'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'sysctls':{'net.ipv4.ip_unprivileged_port_start':'0'},'mem_limit':'64m','pids_limit':32,'networks':{'default':{},'proofsink':{'ipv4_address':sink_ip,'aliases':['receiver.golf.test']}}}},'networks':{'proofsink':{'internal':True,'ipam':{'config':[{'subnet':str(subnet)}]}}}}
        helpers.private_write(directory/'proof.env',''.join(k+"='"+v+"'\n" for k,v in values.items()));helpers.private_write(directory/'services.json',json.dumps(overlay));helpers.private_write(directory/'ports.yaml',f'''services:
  golf:
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
    depends_on:
      native-qualification-proxy: {{condition: service_started}}
  gitea:
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
  runner:
    depends_on: !override {{golf: {{condition: service_started}}, runner-daemon: {{condition: service_healthy}}}}
''')
        env.update(proxy.environment());compose=['docker','compose','--project-directory',str(stack),'-p',project,'--env-file',str(directory/'proof.env'),'-f',str(stack/'compose.yaml'),'-f',str(stack/'compose.ci.yaml'),'-f',str(directory/'services.json'),'-f',str(directory/'ports.yaml')]
        command=lambda *arguments,**kw:run(*compose,*arguments,**kw)
        admin=lambda *arguments:command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*arguments)
        native=rules.native
        def rpc(role,method,body=None,expected=200,code=None):return rules.rpc(actors[role]['session'],method,body,expected,code)
        def control(path,body=None):
            req=urllib.request.Request('http://127.0.0.1:'+str(ports[3])+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+control_key,'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=5) as response:raw=response.read((2<<20)+1);assert len(raw)<=2<<20;return json.loads(raw)
        def until(fn,seconds=90):
            deadline=time.monotonic()+seconds
            while time.monotonic()<deadline:
                value=fn()
                if value:return value
                time.sleep(.4)
            raise AssertionError('Bounded observation deadline exceeded')
        def runtime():
            observed={}
            for service in ('golf','runner','email-worker','webhook-worker'):
                cid=command('ps','-aq',service);assert re.fullmatch(r'[a-f0-9]{12,64}',cid);row=json.loads(run('docker','inspect',cid))[0]
                assert row['Config']['Labels']['com.docker.compose.project']==project and row['Image']==images['runner' if service=='runner' else 'golf']
                observed[service]={'containerId':cid,'imageId':row['Image'],'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash']}
            return observed
        def scalar(query):
            assert query.startswith('SELECT ') and ';' not in query
            value=command('exec','-T','postgres','psql','-U','postgres','-d','golf','-At','-v','ON_ERROR_STOP=1','-c',query);assert re.fullmatch('[0-9]+',value);return int(value)
        def email_history(role):
            result=rpc(role,'EmailNotificationService/ListOwnEmailDeliveries',{'page':{'limit':100},'target':target});assert result['target']==target and not result.get('page',{}).get('nextPage');return result.get('deliveries',[])
        def web_history(role):
            result=rpc('owner','RepositoryWebhookService/ListRepositoryWebhookDeliveries',{'target':target,'subscriptionId':subscriptions[role]['id'],'page':{'limit':100}});assert result['target']==target and not result.get('page',{}).get('nextPage');return result.get('deliveries',[])
        def settled():
            for role in MODES:
                for item in email_history(role):
                    if item['state']!='accepted':return False
                    assert item['smtpStatus']==250 and 1<=item['attempts']<=6
                for item in web_history(role):
                    if item['state']!='accepted':return False
                    assert item['responseStatus']==204 and 1<=item['attempts']<=6
            return True
        runs,subscriptions={},{}
        try:
            stage('fresh ordinary/native/bootstrap/runtime and owned TLS sink');started=True;command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf',native_proxy.SERVICE_NAME,'receiver','runner-daemon',timeout=180);proxy.ready();smoke.ready()
            assert native('','GET','version')['version']=='1.27.3'
            bootstrap=project+'-bootstrap';admin('create','--username',bootstrap,'--email',bootstrap+'@example.invalid','--random-password','--must-change-password=false','--admin');bootstrap_created=True
            for role in ('owner',*MODES):
                actor={'name':project+'-'+role,'session':smoke.client(),'created':False,'enrolled':False};actors[role]=actor;actor.update(email=actor['name']+'@example.invalid',password='Owned workflow mail '+secrets.token_urlsafe(24))
                admin('create','--username',actor['name'],'--email',actor['email'],'--random-password','--must-change-password=false');actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:repository,write:issue','--raw');identity=native(actor['token'],'GET','user');assert identity['login']==actor['name'] and identity['is_admin'] is False;actor['id']=str(identity['id'])
                result=json.loads(command('exec','-T','golf','golf','local-account','create',payload={'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='owner'}));assert result['state']=='complete';actor['enrolled']=True
                rpc(role,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})
            repo=native(actors['owner']['token'],'POST','user/repos',{'name':'notification-proof','private':True,'auto_init':True,'default_branch':'main'},201);repos[repo['full_name']]=repo['id'];repository={'owner':actors['owner']['name'],'name':repo['name']};base='repos/'+repo['full_name'];smoke.wait_for_push(actors['owner']['token'],repo['full_name'])
            for role in MODES:native(actors['owner']['token'],'PUT',base+'/collaborators/'+actors[role]['name'],{'permission':'write' if role=='activity' else 'read'},204)
            target={'repository':repository,'repositoryId':str(repo['id']),'ownerId':str(repo['owner']['id'])};access=rpc('owner','RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access'];assert all(access[k]==target[k] for k in ('repositoryId','ownerId'))
            def sink_ready():
                try:return control('/receipts')
                except (urllib.error.URLError,TimeoutError,ConnectionError):return False
            until(sink_ready,30);control('/recipients',{'recipients':list(roles)})
            stage('explicit local SMTP activation and verified background mailbox consent')
            transport_id=str(uuid.uuid4());saved=rpc('owner','EmailNotificationService/SaveEmailTransport',{'id':transport_id,'expectedVersion':'0','name':'Owned workflow TLS SMTP','host':'receiver.golf.test','port':465,'tlsMode':'implicit','sender':'sender@example.invalid','currentPassword':actors['owner']['password']})['transport'];assert saved['version']=='1'
            active=rpc('owner','EmailNotificationService/ActivateEmailTransport',{'id':transport_id,'version':'1','expectedActivationGeneration':'0','currentPassword':actors['owner']['password']});assert active['transport']['active']
            command('up','-d','--no-build','--pull','never','email-worker',timeout=120)
            for role,mode in MODES.items():
                state=rpc(role,'EmailNotificationService/GetOwnEmailNotifications')['state'];challenge=str(uuid.uuid4());ack=rpc(role,'EmailNotificationService/RequestEmailVerification',{'operationId':challenge,'expectedContactVersion':state['contactVersion']});version=ack['acceptedContactVersion']
                until(lambda:any(v['id']==challenge and v['state']=='accepted' for v in rpc(role,'EmailNotificationService/ListOwnEmailDeliveries',{'page':{'limit':100}}).get('deliveries',[])))
                code=control('/code/'+challenge)['code'];confirmed=rpc(role,'EmailNotificationService/ConfirmEmailVerification',{'challengeId':challenge,'expectedContactVersion':version,'code':code})['state'];del code
                rpc(role,'EmailNotificationService/SaveOwnEmailPreference',{'expectedContactVersion':version,'expectedPreferenceVersion':confirmed['preferenceVersion'],'enabled':True,'authorizeBackground':True})
                sub=rpc(role,'EmailNotificationService/SaveRepositoryEmailSubscription',{'target':target,'id':str(uuid.uuid4()),'expectedVersion':'0','expectedContactVersion':version,'eventTopics':['actions'],'workflowNotifications':mode,'enabled':True,'authorizeBackground':True})['subscription'];assert sub['workflowNotifications']==mode and sub['authorizationState']=='authorized'
                subscription=rpc('owner','RepositoryWebhookService/SaveRepositoryWebhook',{'target':target,'id':str(uuid.uuid4()),'expectedVersion':'0','name':role+' workflow outcomes','endpoint':'https://receiver.golf.test/workflow-proof/'+role,'signingSecret':keys[role],'eventTopics':['actions'],'workflowNotifications':mode,'enabled':True,'authorizeBackground':True})['subscription'];assert subscription['workflowNotifications']==mode;subscriptions[role]=subscription
            command('stop','email-worker')
            stage('exact controlled workflow source and independent manual policies')
            for kind,script in [('success','printf "PRIVATE_EMAIL_QUALIFIER_BODY workflow notification success\\n"'),('failure','exit 7'),('cancel','sleep 30')]:
                contents='name: Owned notification '+kind+'\non: workflow_dispatch\njobs:\n  proof:\n    runs-on: linux\n    steps:\n      - run: '+script+'\n';native(actors['owner']['token'],'POST',base+'/contents/.github/workflows/'+kind+'.yml',{'content':base64.b64encode(contents.encode()).decode(),'message':'Owned workflow notification fixture'},201)
            head=native(actors['owner']['token'],'GET',base+'/branches/main')['commit']['id'];assert re.fullmatch('[a-f0-9]{40}',head)
            for scope in ('INSTANCE','REPOSITORY'):
                selection={'scope':'EXECUTION_SCOPE_'+scope,**({'repository':repository} if scope=='REPOSITORY' else {})};old=rpc('owner','ExecutionPolicyService/GetExecutionPolicy',selection)['policy'];rpc('owner','ExecutionPolicyService/UpdateExecutionPolicy',{**selection,'scopeId':old['scopeId'],'expectedRevision':old['revision'],'expectedAuthorityRevision':old['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            inspection=rpc('owner','WorkflowService/InspectWorkflows',{'repository':repository,'repositoryId':target['repositoryId'],'ref':head});assert inspection['commitId']==head and len(inspection['configurations'])==3 and all(v.get('manualPolicyAllowed') is True and v.get('pushPolicyAllowed') is False for v in inspection['configurations'])
            stage('bounded exact owned daemon image seed; helper never pulls')
            daemon=command('ps','-q','runner-daemon');row=json.loads(run('docker','inspect',daemon))[0];assert row['Image']==images['daemon'] and row['Config']['Labels']['com.docker.compose.project']==project and row['Config']['Labels']['com.docker.compose.service']=='runner-daemon';daemon=row['Id']
            seed_tmp=OUTPUT/'seed-request.json.tmp';helpers.private_write(seed_tmp,json.dumps({'schema':'golf.owned-notification-seed.v1','project':project,'containerId':daemon,'containerImage':images['daemon'],'approvedImage':JOB_IMAGE,'deadlineSeconds':args.seed_wait_seconds,'operatorScope':'Only this owned daemon, no retained resources'}));seed_tmp.replace(OUTPUT/'seed-request.json')
            def seeded():
                result=subprocess.run([*compose,'exec','-T','runner-daemon','docker','image','inspect',JOB_IMAGE],cwd=stack,env=env,capture_output=True,timeout=15)
                if result.returncode:return False
                value=json.loads(result.stdout)[0];assert JOB_IMAGE.split(':',1)[0]+'@'+JOB_IMAGE.split('@',1)[1] in value.get('RepoDigests',[]) and re.fullmatch(r'sha256:[a-f0-9]{64}',value['Id']);return value['Id']
            job_id=until(seeded,args.seed_wait_seconds);record(approvedJobImage=JOB_IMAGE,innerImageId=job_id,seedProvenance='operator-owned seed; helper independently checked exact RepoDigest and image ID; no registry-source claim')
            command('create','--no-build','--pull','never','runner','webhook-worker');baseline=runtime();record(runtimeBefore=baseline)
            def dispatch(kind):
                key=str(uuid.uuid4());out=rpc('owner','WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':'.github/workflows/'+kind+'.yml','idempotencyKey':key})['run'];assert out['commitId']==head and out['repositoryId']==target['repositoryId'] and out['ownerId']==target['ownerId'];assert str(uuid.UUID(out['id']))==out['id'] and uuid.UUID(out['id']).version==4;return out,key
            original_receipts=[]
            def inspect_original(kind,key,expected_run):
                request={'repository':repository,'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'commitId':head,'workflowPath':'.github/workflows/'+kind+'.yml','idempotencyKey':key}
                receipt=rpc('owner','WorkflowRunService/GetWorkflowDispatch',request);run=receipt['run'];assert receipt['repository']==repository and receipt['repositoryId']==target['repositoryId'] and receipt['ownerId']==target['ownerId'] and receipt['nativeActorId']==actors['owner']['id'] and receipt['idempotencyKey']==key and run['id']==expected_run['id'] and run['commitId']==head and run['workflowPath']==request['workflowPath'] and run.get('canCancel',False) is False
                rpc('activity','WorkflowRunService/GetWorkflowDispatch',request,404,'not_found')
                rpc('owner','WorkflowRunService/GetWorkflowDispatch',request|{'idempotencyKey':str(uuid.uuid4())},404,'not_found')
                original_receipts.append({'key':key,'runId':run['id'],'actorId':receipt['nativeActorId'],'repositoryId':receipt['repositoryId'],'ownerId':receipt['ownerId'],'commitId':head,'workflowPath':request['workflowPath'],'canCancel':False,'missingIsNotNoEffect':True})
            cancelled,cancel_key=dispatch('cancel');cancelled=rpc('owner','WorkflowRunService/CancelWorkflowRun',{'runId':cancelled['id'],'expectedVersion':cancelled['version']})['run'];assert cancelled['state']=='WORKFLOW_RUN_STATE_CANCELLED' and not cancelled.get('attemptId');runs[cancelled['id']]=cancelled;inspect_original('cancel',cancel_key,cancelled)
            command('start','runner')
            for kind in ('success','failure'):
                queued,key=dispatch(kind)
                def done():
                    out=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':queued['id']})['run'];return out if out['state'] not in ('WORKFLOW_RUN_STATE_RUNNING','WORKFLOW_RUN_STATE_QUEUED') else None
                out=until(done,120);assert out['state']==('WORKFLOW_RUN_STATE_SUCCEEDED' if kind=='success' else 'WORKFLOW_RUN_STATE_FAILED') and re.fullmatch('[a-f0-9]{32}',out.get('attemptId','')) and out['commitId']==head;assert out['progress']['eventsRecorded'];runs[out['id']]=out;inspect_original(kind,key,out)
            if args.ui:
                stage('single harmless actual manual ACK-loss dispatch and original-only inspection UI')
                browser=stack/'scripts/workflow-dispatch-browser.mjs';assert browser.is_file();ui_output=OUTPUT/'original-dispatch-ui';ui_output.mkdir(mode=0o700)
                selected=next(v for v in inspection['configurations'] if v['path']=='.github/workflows/success.yml')
                config={'stackRoot':str(stack),'golf':smoke.GOLF,'repository':repo['full_name'],'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'actorId':actors['owner']['id'],'commitId':head,'workflowPath':'.github/workflows/success.yml','workflowBlobId':selected['blobId'],'email':actors['owner']['email'],'password':actors['owner']['password'],'runtime':{'containers':baseline,'images':images,'binarySha256':binaries,'sourceRevision':args.source_revision},'output':str(ui_output)}
                run('node',str(browser),payload=config,timeout=180)
                manifest=json.loads((ui_output/'browser-manifest.json').read_text());assert manifest['status']=='browser_checks_passed_parent_cleanup_pending' and len(manifest['captures'])==4
                original=manifest['original'];assert original['repositoryId']==target['repositoryId'] and original['ownerId']==target['ownerId'] and original['actorId']==actors['owner']['id'] and original['commitId']==head and original['workflowPath']=='.github/workflows/success.yml'
                ui_run=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':original['runId']})['run'];assert ui_run['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and ui_run['commitId']==head and ui_run['workflowBlobId']==original['workflowBlobId'] and ui_run['sourceSha256']==original['sourceSha256']
                runs[ui_run['id']]=ui_run;inspect_original('success',original['key'],ui_run);record(originalDispatchBrowser='four_same_original_captures_parent_cleanup_pending')
            stage('real terminal journal/filter outboxes; no direct mutation')
            for run_id,out in runs.items():
                expected=out['state'].removeprefix('WORKFLOW_RUN_STATE_').lower();attempt=out.get('attemptId','')
                assert scalar("SELECT count(*) FROM golf_workflow_notification_events WHERE forge_url='http://native-qualification-proxy:8081' AND run_id='"+run_id+"' AND event_id='workflow-terminal:"+run_id+"' AND state='"+expected+"' AND repository_id="+target['repositoryId']+" AND owner_id="+target['ownerId']+" AND attempt_id='"+attempt+"'")==1
            for role in MODES:
                e=email_history(role);w=web_history(role)
                terminal_expected=set('workflow-terminal:'+v['id'] for v in runs.values() if role=='completed' or role=='failures' and v['state']=='WORKFLOW_RUN_STATE_FAILED')
                assert {v['eventId'] for v in e if v['eventId'].startswith('workflow-terminal:')}==terminal_expected=={v['eventId'] for v in w if v['eventId'].startswith('workflow-terminal:')}
                if role=='activity':assert e and w and all(v['eventId'].startswith('activity:') and v['eventTopic']=='actions' for v in e+w)
                else:assert len(e)==len(w)==len(terminal_expected)
            retry_email=next(v for v in email_history('completed') if v['eventId']=='workflow-terminal:'+next(k for k,v in runs.items() if v['state']=='WORKFLOW_RUN_STATE_SUCCEEDED'))
            retry_web=next(v for v in web_history('failures') if v['eventId'].startswith('workflow-terminal:'))
            drop_email=next(v for v in email_history('completed') if v['eventId']==retry_web['eventId'])
            drop_web=next(v for v in web_history('completed') if v['eventId']==retry_email['eventId'])
            control('/mode',{'id':retry_email['id'],'mode':'retry_once'});control('/mode',{'id':drop_email['id'],'mode':'drop_once'});control('/web-mode',{'id':retry_web['id'],'mode':'retry'});control('/web-mode',{'id':drop_web['id'],'mode':'drop'})
            command('start','email-worker','webhook-worker');until(settled,180)
            facts=control('/workflow-facts');closed=[event_receipt(v,keys,target,runs) for v in facts['webhooks']]
            for role in MODES:
                for delivery in email_history(role):
                    matches=[v for v in facts['mail'] if v['deliveryId']==delivery['id'] and v['role']==role];assert len(matches)==delivery['attempts']
                    if delivery['eventId'].startswith('workflow-terminal:'):
                        run=runs[delivery['eventId'].removeprefix('workflow-terminal:')]
                        for fact in matches:assert fact['runId']==run['id'] and fact['attemptId']==(run.get('attemptId') or 'Not assigned') and fact['repositoryId']==target['repositoryId'] and fact['ownerId']==target['ownerId'] and fact['link']==smoke.GOLF+'/'+repository['owner']+'/'+repository['name']+'/actions/runs/'+run['id'] and fact['truthfulCancellation'] and fact['truthfulLost']
                    else:assert all(v.get('activity') is True for v in matches)
            smtp_records=[email.receiver_receipt(v) for v in control('/receipts')['receipts']]
            for identifier,rows in [(retry_email['id'],smtp_records),(drop_email['id'],smtp_records),(retry_web['id'],closed),(drop_web['id'],closed)]:
                copies=[v for v in rows if v['deliveryId']==identifier];assert len(copies)==2 and copies[0]['bodySha256']==copies[1]['bodySha256']
            assert next(v for v in email_history('completed') if v['id']==drop_email['id']).get('possibleDuplicate') is True and next(v for v in email_history('completed') if v['id']==retry_email['id']).get('possibleDuplicate',False) is False
            assert next(v for v in web_history('completed') if v['id']==drop_web['id']).get('possibleDuplicate') is True and next(v for v in web_history('failures') if v['id']==retry_web['id']).get('possibleDuplicate',False) is False
            count=len(facts['webhooks'])+len(facts['mail']);command('restart','golf','email-worker','webhook-worker');smoke.ready();time.sleep(3);after=control('/workflow-facts');assert len(after['webhooks'])+len(after['mail'])==count and runtime()==baseline
            record(runtimeAfter=runtime(),runs=[{k:v.get(k,'') for k in ('id','state','commitId','workflowPath','workflowBlobId','sourceSha256','attemptId')} for v in runs.values()],originalDispatchReceipts=original_receipts,hmacReceipts=closed,smtpReceipts=smtp_records,filterModesVerified=list(MODES),retryFrozenBodies=True,acceptedResponseLossFrozenBodies=True,restartNoDuplicate=True,lost='not_exercised',timedOut='not_exercised');passed=True
        except Exception as error:
            record(failedStage=STAGE,**closed_failure(error));raise
        finally:
            failures=[]
            if started:
                try:command('stop','-t','20','runner','email-worker','webhook-worker')
                except Exception:failures.append('worker stop')
                for actor in actors.values():
                    if actor['enrolled']:
                        try:rules.rpc(actor['session'],'SessionService/Logout');command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']})
                        except Exception:failures.append('managed session/account cleanup')
                for name,identity in repos.items():
                    try:assert native(actors['owner']['token'],'GET','repos/'+name)['id']==identity;native(actors['owner']['token'],'DELETE','repos/'+name,expected=204)
                    except Exception:failures.append('owned native repo')
                for actor in reversed(list(actors.values())):
                    if actor['created']:
                        try:
                            identity=native(actor.get('token',''),'GET','users/'+actor['name']);assert identity['login']==actor['name'] and (actor.get('id') is None or str(identity['id'])==actor['id']);admin('delete','--username',actor['name'],'--purge');native('','GET','users/'+actor['name'],expected=404)
                        except Exception:failures.append('owned native actor')
                try:proxy.close();command('down','--volumes','--remove-orphans',timeout=180)
                except Exception:failures.append('owned resources')
                try:
                    for arguments in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project)
                    assert set(run('docker','ps','-aq').splitlines())==foreign and foreign_snapshot()==foreign_before
                except Exception:failures.append('foreign/resource identity')
            rules.ACTIVE_PROXY=None;smoke.GOLF,smoke.GITEA=previous
            record(status='qualified' if passed and not failures else 'failed',cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures,bootstrapCleanup='fresh_owned_native_volume_removed' if bootstrap_created and not failures else 'not_claimed',originalFailurePreserved=bool(PROOF.get('failedStage')))
            if failures and passed:raise AssertionError('Owned cleanup incomplete')
    if passed:print('PASS: bounded056 real workflow terminal SMTP/HMAC filters/retries; cleanup separate, broader gates remain open')

if __name__=='__main__':
    signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(RuntimeError('Interrupted')))
    signal.signal(signal.SIGINT,lambda *_:(_ for _ in ()).throw(RuntimeError('Interrupted')))
    try:main()
    except Exception as error:record(status='failed',failedStage=PROOF.get('failedStage',STAGE),**closed_failure(error));print('Workflow notification proof failed at '+PROOF.get('failedStage',STAGE)+'; '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr);sys.exit(1)

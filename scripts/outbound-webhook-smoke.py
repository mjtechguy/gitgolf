#!/usr/bin/env python3
"""Controlled HTTPS outbound-webhook qualification in a fresh Compose project.

Prepared source is not runtime evidence. Requires explicitly supplied, existing
local Golf/Python images; never builds, pulls, deploys the retained stack or sends
to third parties. Uses supported native APIs and Golf RPC/operator enrollment,
no database writes. Fixture secrets and raw receiver records stay owner-only.
The receiver is an owned internal bridge HTTPS443 exception, not public DNS/TLS,
email, Slack, Cloudflare or a semantic notification qualification.
"""
import argparse
import ast
import base64
import hashlib
import hmac
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
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'RepositoryWebhookService/'
METHODS = ('ListRepositoryWebhooks', 'SaveRepositoryWebhook',
           'ListRepositoryWebhookDeliveries', 'TestRepositoryWebhook',
           'RedeliverRepositoryWebhook')
STAGE = 'initialization'
LIMIT = 4 << 20
NATIVE_IMAGE = 'gitea/gitea:1.27.3-rootless'
PG_IMAGE = 'postgres:18.4-alpine3.24'
CA_CONFIG = '''[req]
distinguished_name=ca_subject
x509_extensions=ca_extensions
prompt=no
[ca_subject]
CN=Golf-owned webhook proof CA
[ca_extensions]
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
import base64, hashlib, hmac, json, os, socket, ssl, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
config=json.loads(Path('/fixture/sink.json').read_text());lock=threading.Lock()
records=[];counts={};state=Path('/state/receipts.json')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(200 if self.path=='/health' else 404);self.end_headers()
 def do_POST(self):
  try:
   size=int(self.headers.get('Content-Length','-1'))
   if not 0<size<=16384 or not self.path.startswith(config['prefix']+'/'): raise ValueError()
   body=self.rfile.read(size);event=self.headers['X-Golf-Event-ID'];delivery=self.headers['X-Golf-Delivery-ID'];stamp=self.headers['X-Golf-Timestamp'];signature=self.headers['X-Golf-Signature-256']
   assert len(body)==size and len(event)<=128 and str(int(stamp))==stamp and abs(time.time()-int(stamp))<=60
   uuid_module=__import__('uuid');assert str(uuid_module.UUID(delivery))==delivery
   expected='sha256='+hmac.new(config['key'].encode(),stamp.encode()+b'\n'+event.encode()+b'\n'+body,hashlib.sha256).hexdigest()
   assert hmac.compare_digest(signature,expected)
   parsed=json.loads(body);assert parsed['schema']=='golf.webhook.v1' and parsed['event_id']==event
   mode=self.path.rsplit('/',1)[-1];assert mode in ('accept','retry','drop','redirect')
   with lock:
    assert len(records)<2000
    counts[delivery]=counts.get(delivery,0)+1;attempt=counts[delivery]
    records.append({'eventId':event,'deliveryId':delivery,'timestamp':stamp,'signature':signature,'bodyBase64':base64.b64encode(body).decode(),'mode':mode,'requestIndex':attempt})
    temp=state.with_suffix('.next');temp.write_text(json.dumps(records));temp.chmod(0o600);temp.replace(state)
   if mode=='drop' and attempt==1:
    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
   self.send_response(302 if mode=='redirect' else 503 if mode=='retry' and attempt==1 else 204)
   if mode=='redirect':self.send_header('Location','https://receiver.golf.test'+config['prefix']+'/accept')
   if mode=='retry' and attempt==1:self.send_header('Retry-After','1')
   self.end_headers()
  except Exception:
   self.send_response(400);self.end_headers()
server=ThreadingHTTPServer(('0.0.0.0',443),Handler)
server.timeout=5
tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.minimum_version=ssl.TLSVersion.TLSv1_2
tls.load_cert_chain('/fixture/server.crt','/fixture/server.key');server.socket=tls.wrap_socket(server.socket,server_side=True)
state.write_text('[]');state.chmod(0o600);server.serve_forever()
'''

BROWSER = r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,context,config,stage='initialization';function check(v){if(!v)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:1000}});const h={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers:h,data:{username:config.email,password:config.password}})).status()===200);
 const page=await context.newPage(),errors=[],writes=[];page.on('pageerror',()=>errors.push(true));page.on('request',r=>{if(/RepositoryWebhookService\/(Save|Test|Redeliver)/.test(r.url()))writes.push(r.url().split('/').at(-1));});
 stage='actual metadata inventory';await page.goto(config.golf+'/'+config.repository+'/settings/webhooks');const table=page.getByRole('table',{name:'Repository webhooks',exact:true});await table.waitFor();check(await page.getByRole('form',{name:'Webhook subscription editor',exact:true}).count()===0);
 stage='explicit Add and saved encrypted fields';await page.getByRole('button',{name:'Add webhook',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Browser receiver');await page.getByLabel('Destination URL',{exact:true}).fill(config.endpoint);await page.getByLabel('Signing secret',{exact:true}).fill(config.key);await page.getByLabel('Enable delivery',{exact:true}).check();await page.getByLabel('Authorize delivery using my local Golf account after browser logout',{exact:true}).check();await page.getByRole('button',{name:'Save webhook',exact:true}).click();await page.getByRole('form',{name:'Webhook subscription editor',exact:true}).waitFor({state:'detached'});await page.getByRole('button',{name:'Edit webhook Browser receiver',exact:true}).waitFor();
 stage='explicit Edit private replacement fields blank';await page.getByRole('button',{name:'Edit webhook Browser receiver',exact:true}).click();check(await page.getByLabel('Replace destination URL (optional)',{exact:true}).inputValue()===''&&await page.getByLabel('Replace signing secret (optional)',{exact:true}).inputValue()==='');await page.getByLabel('Name',{exact:true}).fill('Browser receiver renamed');await page.getByLabel('Authorize delivery using my local Golf account after browser logout',{exact:true}).check();await page.getByRole('button',{name:'Save webhook',exact:true}).click();await page.getByRole('form',{name:'Webhook subscription editor',exact:true}).waitFor({state:'detached'});
 stage='actual queued test and delivery history';await page.getByRole('button',{name:'Send test for Browser receiver renamed',exact:true}).click();const history=page.getByRole('table',{name:'Webhook deliveries',exact:true});await history.waitFor();for(let i=0;i<60;i++){if(await history.getByText('accepted',{exact:true}).count())break;await page.getByRole('button',{name:'Refresh delivery history',exact:true}).click();await page.waitForTimeout(500);}await history.getByText('accepted',{exact:true}).waitFor({timeout:1000});const beforeReload=writes.length;await page.reload();await table.waitFor();await page.getByRole('button',{name:'Delivery history for Browser receiver renamed',exact:true}).click();await history.getByText('accepted',{exact:true}).waitFor();check(writes.length===beforeReload);
 stage='explicit duplicate confirmation without dispatch';await history.getByRole('button',{name:/^Redeliver /}).first().click();await page.getByRole('dialog',{name:'Send this event again?',exact:true}).waitFor();check(writes.length===beforeReload);await page.getByRole('button',{name:'Cancel',exact:true}).click();check(writes.length===beforeReload);
 const metrics=[];for(const theme of ['dark','light'])for(const width of [1440,390]){
  stage='served webhook capture '+theme+' '+width;await page.setViewportSize({width,height:1000});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check(await page.locator('html').getAttribute('data-theme')===theme);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const capture=async kind=>{const text=await page.locator('body').innerText();check(!text.includes(config.key)&&!text.includes(config.endpoint)&&!text.includes(config.prefix));check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(config.screenshots,'webhooks-'+kind+'-'+theme+'-'+width+'.png'),fullPage:true});metrics.push({theme,width,kind,documentWidth:await page.evaluate(()=>document.documentElement.scrollWidth),overflow:false});};await page.reload();await table.waitFor();check(await page.locator('html').getAttribute('data-theme')===theme);check(writes.length===beforeReload);await capture('inventory');await page.getByRole('button',{name:'Delivery history for Browser receiver renamed',exact:true}).click();await history.getByText('accepted',{exact:true}).waitFor();await capture('history');await page.getByRole('button',{name:'Edit webhook Browser receiver renamed',exact:true}).click();check(await page.getByLabel('Replace destination URL (optional)',{exact:true}).inputValue()===''&&await page.getByLabel('Replace signing secret (optional)',{exact:true}).inputValue()==='');await capture('editor');await page.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 stage='live native admin removal clears editor and inventory';await page.getByRole('button',{name:'Add webhook',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Unsent private editor');await page.getByLabel('Destination URL',{exact:true}).fill(config.endpoint);check((await context.request.delete(config.native+'/api/v1/repos/'+config.repository+'/collaborators/'+config.username,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange',{bubbles:true})));await page.getByRole('form',{name:'Webhook subscription editor',exact:true}).waitFor({state:'detached',timeout:20000});check(await table.count()===0);check(!(await page.locator('body').innerText()).includes('Browser receiver renamed')&&errors.length===0);
 await writeFile(join(config.screenshots,'browser.json'),JSON.stringify({runtime:config.runtime,metrics,explicitSaves:2,explicitTests:1,reloadNoDispatch:true,revocationCleared:true},null,2),{mode:0o600});console.log('PASS: actual settings Add/Edit/test/history/reload/confirmation, twelve theme/width/state captures and native-admin revocation');
}catch(e){console.error('Webhook browser failed at '+stage+'; '+(e.name==='TimeoutError'?'TimeoutError':'assertion/error')+'; private diagnostics withheld');process.exitCode=1;}
finally{if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Webhook browser logout failed');process.exitCode=1;}await browser?.close();}
'''


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: ' + value, flush=True)


def private_write(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write(value)


def signed(key, stamp, event, body):
    return 'sha256=' + hmac.new(key.encode(), stamp.encode()+b'\n'+event.encode()+b'\n'+body, hashlib.sha256).hexdigest()


def positive(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[1-9][0-9]{0,18}', value)) and int(value) <= 9223372036854775807


def target_receipt(value, target):
    assert value.get('target') == target, 'Exact webhook target receipt mismatch'
    return value


def verify_records(records, key):
    assert isinstance(records, list) and len(records) <= 2000
    for row in records:
        assert set(row) == {'eventId', 'deliveryId', 'timestamp', 'signature', 'bodyBase64', 'mode', 'requestIndex'}
        assert str(uuid.UUID(row['deliveryId'])) == row['deliveryId']
        assert row['mode'] in ('accept', 'retry', 'drop', 'redirect') and type(row['requestIndex']) is int and 1 <= row['requestIndex'] <= 6
        assert row['timestamp'] == str(int(row['timestamp']))
        body = base64.b64decode(row['bodyBase64'], validate=True)
        assert 0 < len(body) <= 16384 and hmac.compare_digest(row['signature'], signed(key, row['timestamp'], row['eventId'], body))
        event = json.loads(body)
        assert event['schema'] == 'golf.webhook.v1' and event['event_id'] == row['eventId']
        if event['event'] == 'golf.webhook.test':
            assert set(event) == {'schema', 'event', 'event_id'} and row['eventId'].startswith('test:')
        else:
            assert set(event) == {'schema', 'event', 'event_id', 'producer', 'repository_id', 'occurred_at'}
            assert event['event'] in ['repository.activity.'+v for v in ('source', 'issues', 'pulls', 'actions')]
            assert event['producer'] == 'golf.repository_activity' and positive(event['repository_id']) and row['eventId'].startswith('activity:')
    return records


def receipt_metadata(records, key):
    # Revalidate exact raw bytes before deleting the private temporary fixture.
    # Retain public signature/hash/identity observations, never body/key/URL.
    verified = verify_records(records, key)
    return [{**{field:row[field] for field in ('deliveryId', 'eventId', 'timestamp', 'signature', 'mode', 'requestIndex')},
             'bodyBytes':len(base64.b64decode(row['bodyBase64'], validate=True)),
             'bodySha256':hashlib.sha256(base64.b64decode(row['bodyBase64'], validate=True)).hexdigest(),
             'signatureVerified':True} for row in verified]


def self_check(stack):
    ast.parse(SINK)
    key, stamp, event = 'K'*32, '1791086400', 'test:'+str(uuid.uuid4())
    body = json.dumps({'schema': 'golf.webhook.v1', 'event': 'golf.webhook.test', 'event_id': event}, separators=(',', ':')).encode()
    row = {'eventId': event, 'deliveryId': str(uuid.uuid4()), 'timestamp': stamp,
           'signature': signed(key, stamp, event, body), 'bodyBase64': base64.b64encode(body).decode(), 'mode': 'accept', 'requestIndex': 1}
    verify_records([row], key)
    metadata = receipt_metadata([row], key)
    assert metadata[0]['bodySha256'] == hashlib.sha256(body).hexdigest() and metadata[0]['bodyBytes'] == len(body)
    assert metadata[0]['signature'] == row['signature'] and metadata[0]['signatureVerified']
    assert 'bodyBase64' not in metadata[0] and key not in json.dumps(metadata) and body.decode() not in json.dumps(metadata)
    assert 'x509_extensions=ca_extensions' in CA_CONFIG and 'basicConstraints=critical,CA:TRUE,pathlen:0' in CA_CONFIG
    assert 'keyUsage=critical,keyCertSign,cRLSign' in CA_CONFIG and 'basicConstraints=critical,CA:FALSE' in SERVER_EXTENSIONS
    for field in ('signature', 'eventId', 'bodyBase64'):
        wrong = {**row, field: 'invalid'}
        try:
            verify_records([wrong], key)
        except (AssertionError, ValueError):
            pass
        else:
            raise AssertionError('Invalid signed record admitted')
    for bad in ('0', '01', '-1', '9223372036854775808', '1e2'):
        assert not positive(bad)
    source = (stack/'api/golf/v1/golf.proto').read_text()
    for method in METHODS:
        assert 'rpc '+method+'(' in source
    for name, fields in {
        'RepositoryWebhookTarget': [('RepositoryKey', 'repository', 1), ('string', 'repository_id', 2), ('string', 'owner_id', 3)],
        'SaveRepositoryWebhookRequest': [('string', 'id', 2), ('string', 'expected_version', 3), ('string', 'endpoint', 6), ('string', 'signing_secret', 7), ('bool', 'authorize_background', 9)],
        'RepositoryWebhookDelivery': [('string', 'id', 1), ('string', 'event_id', 4), ('string', 'state', 6), ('bool', 'possible_duplicate', 13)],
    }.items():
        declaration = re.search(r'message '+name+r'\s*\{([^}]+)\}', source).group(1)
        for kind, field, number in fields:
            assert re.search(re.escape(kind)+r'\s+'+field+r'\s*=\s*'+str(number)+r'\s*;', declaration)
    with tempfile.TemporaryDirectory(prefix='golf-webhook-js-check-') as temporary:
        path = Path(temporary)/'browser.mjs'; private_write(path, BROWSER)
        result = subprocess.run(['node', '--check', str(path)], capture_output=True, timeout=15)
        assert result.returncode == 0, 'Browser source syntax check failed'
    print('PASS: pure webhook receipt/signature/protobuf/receiver/browser-source checks; no runtime/network operations')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--stack-root', type=Path, default=ROOT, help='Source checkout containing the combined compose/protobuf; retained .env is never read')
    parser.add_argument('--image', help='Existing locally built combined Golf image; no pull/build')
    parser.add_argument('--sink-image', help='Explicit existing local Python3 image; no pull/build')
    parser.add_argument('--source-commit', help='Explicit served product40hex revision; checked against image label when present')
    parser.add_argument('--screenshots', type=Path, help='Optional new owner-only actual browser capture directory')
    args = parser.parse_args()
    stack = args.stack_root.resolve()
    if args.self_check:
        self_check(stack); return
    if not args.image or not args.sink_image or not re.fullmatch(r'[0-9a-f]{40}', args.source_commit or ''):
        parser.error('Actual qualification requires --image, --sink-image and exact --source-commit')
    if not all((stack/p).is_file() for p in ('compose.yaml', 'compose.webhooks.yaml', 'deploy/postgres/init.sh')):
        parser.error('Combined webhook source/overlay is required')
    screens = args.screenshots.resolve() if args.screenshots else None
    if screens:
        if screens.exists() and any(screens.iterdir()):
            parser.error('Use a new or empty capture directory')
        if not (stack/'web/node_modules/playwright/index.mjs').is_file():
            parser.error('Actual browser proof needs existing local Playwright')
        screens.mkdir(parents=True, exist_ok=True, mode=0o700); screens.chmod(0o700)
    environment = {k:v for k,v in os.environ.items() if not k.startswith(('GOLF_', 'GITEA_', 'POSTGRES_', 'COMPOSE_', 'OTEL_', 'AWS_', 'RUSTFS_')) and k not in ('DATABASE_URL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'SSL_CERT_FILE', 'SSL_CERT_DIR')}
    environment['COMPOSE_DISABLE_ENV_FILE'] = 'true'
    def run(*command, payload=None, timeout=120):
        result = subprocess.run(command, cwd=stack, env=environment, input=payload, capture_output=True, text=True, timeout=timeout)
        assert result.returncode == 0 and len(result.stdout.encode()) <= LIMIT and len(result.stderr.encode()) <= LIMIT, 'Private subprocess failed; output withheld'
        return result.stdout.strip()
    stage('exact local images and reserve; no build or pull')
    images = {}; revision = None
    for name, reference in [('golf', args.image), ('sink', args.sink_image), ('native', NATIVE_IMAGE), ('postgres', PG_IMAGE)]:
        entry = json.loads(run('docker', 'image', 'inspect', reference))[0]
        assert re.fullmatch(r'sha256:[0-9a-f]{64}', entry['Id'])
        images[name] = entry['Id']
        if name == 'golf':
            revision = (entry['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')
            assert not revision or revision == args.source_commit, 'Supplied served revision differs from immutable image label'
    space = run('docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/df', images['golf'], '-Pk', '/')
    assert int(space.splitlines()[-1].split()[3]) >= 2*1024*1024, 'Require at least2GiB VM reserve before fresh stack'
    spec = importlib.util.spec_from_file_location('webhook_helpers', stack/'scripts/observability-smoke.py')
    helpers = importlib.util.module_from_spec(spec); spec.loader.exec_module(helpers)
    ports = helpers.free_ports(2)
    previous = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'http://127.0.0.1:{ports[0]}', f'http://127.0.0.1:{ports[1]}'
    project = 'golf-webhook-proof-'+secrets.token_hex(5)
    existing = [json.loads(line) for line in run('docker', 'network', 'ls', '--format', '{{json .ID}}').splitlines()]
    networks = [json.loads(run('docker', 'network', 'inspect', identifier))[0] for identifier in existing]
    occupied = [ipaddress.ip_network(row['Subnet']) for network in networks for row in (network.get('IPAM', {}).get('Config') or []) if row.get('Subnet')]
    subnet = next((ipaddress.ip_network(f'172.30.{i}.0/24') for i in range(32, 224) if not any(ipaddress.ip_network(f'172.30.{i}.0/24').overlaps(n) for n in occupied if n.version == 4)), None)
    assert subnet, 'No unused private fixture subnet'
    sink_ip = str(subnet.network_address+10)
    prefix = '/golf-owned-'+secrets.token_hex(12)
    endpoint = 'https://receiver.golf.test'+prefix+'/accept'
    key = secrets.token_urlsafe(36)
    actors, started, success, baseline, cleanup_errors = {}, False, False, None, []
    results = {'preparedScope': 'owned internal HTTPS443 operator exception; generic activity only', 'productSourceRevision': args.source_commit,
               'workingSourceRevision': run('git', 'rev-parse', 'HEAD'), 'imageIds': images,
               'sourceRevisionProvenance': 'exact image label' if revision else 'operator supplied; image has no embedded source label',
               'privateAgentExclusion': 'source PostgreSQL regression only; no provider/task runtime exercised',
               'unqualified': ['public production DNS/TLS', 'email/Slack/Cloudflare', 'typed semantic notifications', 'SQL acknowledgement loss', 'latest040 recovery', 'Kubernetes egress', 'million-scale fanout']}
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        fixture, state_dir = directory/'fixture', directory/'state'
        fixture.mkdir(mode=0o700); state_dir.mkdir(mode=0o700)
        private_write(fixture/'sink.py', SINK)
        private_write(fixture/'sink.json', json.dumps({'key':key, 'prefix':prefix}))
        private_write(fixture/'ca.conf', CA_CONFIG)
        private_write(fixture/'extensions', SERVER_EXTENSIONS)
        stage('owned CA and server certificate; no insecure TLS')
        run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(fixture/'ca.conf'),'-keyout',str(fixture/'ca.key'),'-out',str(fixture/'ca.crt'))
        run('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=receiver.golf.test','-keyout',str(fixture/'server.key'),'-out',str(fixture/'server.csr'))
        run('openssl','x509','-req','-days','1','-in',str(fixture/'server.csr'),'-CA',str(fixture/'ca.crt'),'-CAkey',str(fixture/'ca.key'),'-CAcreateserial','-extfile',str(fixture/'extensions'),'-out',str(fixture/'server.crt'))
        (fixture/'ca.key').chmod(0o600); (fixture/'server.key').chmod(0o600); (fixture/'ca.crt').chmod(0o644)
        policy = json.dumps([{'origin':'https://receiver.golf.test', 'addresses':[sink_ip], 'path_prefix':prefix},
                             {'origin':'https://receiver-bad.golf.test', 'addresses':[sink_ip], 'path_prefix':prefix}])
        values = {name:secrets.token_hex(24) for name in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(), GOLF_PUBLIC_URL=smoke.GOLF, GOLF_WEBHOOK_EGRESS_POLICY=policy)
        env_file, override = directory/'proof.env', directory/'proof.yaml'
        private_write(env_file, ''.join(name+"='"+value+"'\n" for name,value in values.items()))
        private_write(override, f'''services:
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
    volumes: ["{fixture/'ca.crt'}:/proof-ca.crt:ro"]
    mem_limit: 384m
    cpus: 1
  webhook-worker:
    image: {images['golf']}
    pull_policy: never
    environment:
      SSL_CERT_FILE: /proof-ca.crt
    volumes: ["{fixture/'ca.crt'}:/proof-ca.crt:ro"]
  receiver:
    image: {images['sink']}
    pull_policy: never
    user: "{os.getuid()}:{os.getgid()}"
    entrypoint: [python3, /fixture/sink.py]
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    sysctls:
      net.ipv4.ip_unprivileged_port_start: '0'
    mem_limit: 64m
    cpus: 0.25
    pids_limit: 32
    tmpfs: [/tmp:size=16777216,mode=1777]
    volumes: ["{fixture}:/fixture:ro", "{state_dir}:/state"]
    networks:
      default:
        ipv4_address: {sink_ip}
        aliases: [receiver.golf.test, receiver-bad.golf.test]
networks:
  default:
    internal: true
    ipam:
      config: [{{subnet: {subnet}}}]
''')
        compose = ['docker','compose','--project-directory',str(stack),'-p',project,'--env-file',str(env_file),'-f',str(stack/'compose.yaml'),'-f',str(stack/'compose.webhooks.yaml'),'-f',str(override)]
        def command(*arguments, payload=None, timeout=120):
            return run(*compose,*arguments,payload=None if payload is None else json.dumps(payload),timeout=timeout)
        def admin(*arguments):
            return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*arguments)
        def rpc(role, method, body=None, expected=200, extra=None):
            return smoke.rpc(actors[role]['session'], method, body, expected=expected, headers=extra)
        def call(role, method, body=None, expected=200, extra=None):
            return rpc(role, SERVICE+method, body, expected, extra)
        def runtime():
            result = {}
            for service in ('golf','webhook-worker'):
                identifier = command('ps','-aq',service)
                assert re.fullmatch(r'[0-9a-f]{12,64}',identifier)
                row = json.loads(run('docker','inspect',identifier))[0]
                assert row['Image'] == images['golf']
                result[service] = {'imageReference':row['Config']['Image'], 'ociImageId':row['Image'], 'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash']}
            return result
        def records():
            return verify_records(json.loads((state_dir/'receipts.json').read_text()), key)
        def list_subs(role='owner', selected=None):
            response=target_receipt(call(role,METHODS[0],{'target':selected or target,'page':{'limit':100}}),selected or target)
            assert not response.get('page',{}).get('nextPage') and response.get('backgroundAuthorizationSupported')
            for row in response.get('subscriptions',[]):
                assert 'endpoint' not in row and 'signingSecret' not in row and row['destinationHost'] in ('receiver.golf.test','receiver-bad.golf.test')
            return response.get('subscriptions',[])
        def history(sub, role='owner', selected=None):
            response=target_receipt(call(role,METHODS[2],{'target':selected or target,'subscriptionId':sub['id'],'page':{'limit':100}}),selected or target)
            assert not response.get('page',{}).get('nextPage')
            return response.get('deliveries',[])
        def save(name, mode='accept', old=None, enabled=True, role='admin'):
            body={'target':target,'id':old['id'] if old else str(uuid.uuid4()),'expectedVersion':old['version'] if old else '0','name':name,'eventTopics':['issues'],'enabled':enabled,'authorizeBackground':enabled}
            if not old: body.update(endpoint='https://receiver.golf.test'+prefix+'/'+mode,signingSecret=key)
            result=target_receipt(call(role,METHODS[1],body),target)['subscription']
            assert result['id']==body['id'] and result['version']==str(int(body['expectedVersion'])+1) and result.get('enabled',False)==enabled
            assert key not in json.dumps(result) and prefix not in json.dumps(result)
            return result
        def queue(sub, operation=None):
            operation=operation or str(uuid.uuid4())
            body={'target':target,'subscriptionId':sub['id'],'expectedVersion':sub['version'],'operationId':operation}
            result=target_receipt(call('admin',METHODS[3],body),target)['delivery']
            assert result['id']==operation and result['subscriptionId']==sub['id'] and result['eventId']=='test:'+operation
            return result,body
        def until(check, timeout=45):
            deadline=time.monotonic()+timeout
            while time.monotonic()<deadline:
                result=check()
                if result:return result
                time.sleep(.4)
            raise AssertionError('Bounded observation deadline exceeded')
        def terminal(sub, delivery):
            return until(lambda:next((row for row in history(sub) if row['id']==delivery['id'] and row['state'] in ('accepted','failed','cancelled')),None))
        try:
            stage('fresh core and owned HTTPS receiver; consumer intentionally stopped')
            started=True
            command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf','receiver',timeout=180)
            smoke.ready()
            assert smoke.provider('','GET','version')['version']=='1.27.3'
            until(lambda: (state_dir/'receipts.json').is_file())
            stage('ordinary native actors and managed local-account enrollment')
            for role in ('owner','admin','reader','outsider'):
                name=project.replace('golf-webhook-proof-','wh-')+'-'+role
                admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false')
                token=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:repository,write:issue','--raw')
                password='Owned webhook '+secrets.token_urlsafe(24)
                result=json.loads(command('exec','-T','golf','golf','local-account','create',payload={'username':name,'email':name+'@example.invalid','password':password,'forge_token':token,'is_instance_admin':False}))
                assert result['state']=='complete'
                actors[role]={'name':name,'token':token,'password':password,'session':smoke.client(),'enrolled':True}
                rpc(role,'SessionService/LoginWithPassword',{'username':name+'@example.invalid','password':password})
            native=smoke.provider(actors['owner']['token'],'POST','user/repos',{'name':'webhook-proof','private':True,'auto_init':True},expected=201)
            other=smoke.provider(actors['owner']['token'],'POST','user/repos',{'name':'other-proof','private':True,'auto_init':True},expected=201)
            repository={'owner':actors['owner']['name'],'name':native['name']};route='repos/'+repository['owner']+'/'+repository['name']
            for role,permission in [('admin','admin'),('reader','read')]:
                smoke.provider(actors['owner']['token'],'PUT',route+'/collaborators/'+actors[role]['name'],{'permission':permission},expected=204)
            access=rpc('admin','RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
            target={'repository':repository,'repositoryId':access['repositoryId'],'ownerId':access['ownerId']}
            assert target['repositoryId']==str(native['id']) and target['ownerId']==str(native['owner']['id'])
            assert positive(target['repositoryId']) and positive(target['ownerId'])
            stage('current native admin only; Origin and valid read-only bearer refusal')
            for role,expected in [('reader',403),('outsider',404)]:call(role,METHODS[0],{'target':target},expected)
            call('admin',METHODS[0],{'target':{**target,'repositoryId':str(int(target['repositoryId'])+100000)}},404)
            call('admin',METHODS[0],{'target':target},403,{'Origin':'https://wrong.invalid'})
            delegation=rpc('admin','ApiCredentialService/CreateApiCredential',{'label':'Webhook no delegation','lifetimeSeconds':600})
            smoke.rpc(smoke.client(),SERVICE+METHODS[0],{'target':target},expected=403,headers={'Authorization':'Bearer '+delegation['token']})
            rpc('admin','ApiCredentialService/RevokeApiCredential',{'credentialId':delegation['credential']['id']})
            token_session=smoke.client()
            smoke.rpc(token_session,'SessionService/LoginWithGiteaToken',{'token':actors['admin']['token']})
            try:
                observed=target_receipt(smoke.rpc(token_session,SERVICE+METHODS[0],{'target':target}),target)
                assert not observed.get('backgroundAuthorizationSupported')
                smoke.rpc(token_session,SERVICE+METHODS[1],{'target':target,'id':str(uuid.uuid4()),'expectedVersion':'0','name':'Unsupported delegation','eventTopics':['issues'],'endpoint':endpoint,'signingSecret':key,'enabled':True,'authorizeBackground':True},expected=400)
            finally:smoke.rpc(token_session,'SessionService/Logout')
            stage('private URL/operator boundary refusal and metadata-only saved configuration')
            for bad in ('http://169.254.169.254/metadata','https://receiver.golf.test/not-approved','https://receiver.golf.test'+prefix+'-neighbor/accept'):
                call('admin',METHODS[1],{'target':target,'id':str(uuid.uuid4()),'expectedVersion':'0','name':'Refused','eventTopics':['issues'],'endpoint':bad,'signingSecret':key,'enabled':True,'authorizeBackground':True},400)
            sub=save('Owned receiver')
            queued,intent=queue(sub)
            assert queued['state']=='queued' and not queued.get('attempts') and not records()
            assert target_receipt(call('admin',METHODS[3],intent),target)['delivery']['id']==queued['id']
            other_target={'repository':{'owner':repository['owner'],'name':other['name']},'repositoryId':str(other['id']),'ownerId':target['ownerId']}
            call('owner',METHODS[2],{'target':other_target,'subscriptionId':sub['id']},404)
            stage('explicit logout consent; real worker acceptance and independent exact HMAC')
            command('create','--no-build','--pull','never','webhook-worker')
            baseline=runtime();results['runtimeBefore']=baseline
            rpc('admin','SessionService/Logout')
            command('start','webhook-worker')
            accepted=terminal(sub,queued);assert accepted['state']=='accepted' and accepted['responseStatus']==204 and accepted['attempts']==1
            first=next(row for row in records() if row['deliveryId']==queued['id']);assert first['eventId']==queued['eventId']
            smoke.rpc(actors['admin']['session'],SERVICE+METHODS[0],{'target':target},expected=401)
            rpc('admin','SessionService/LoginWithPassword',{'username':actors['admin']['name']+'@example.invalid','password':actors['admin']['password']})
            assert runtime()==baseline
            count=len(records());command('restart','golf','webhook-worker');smoke.ready();assert history(sub)[0]['id']==queued['id'];time.sleep(2);assert len(records())==count
            stage('committed real issue producer; private issue body excluded from payload')
            issue=rpc('owner','RepositoryService/CreateIssue',{'repository':repository,'repositoryId':target['repositoryId'],'title':'Controlled activity','body':'PRIVATE_ISSUE_BODY_NOT_FOR_WEBHOOK','idempotencyKey':str(uuid.uuid4())})
            assert issue['mutation']['state']=='ISSUE_MUTATION_STATE_SUCCEEDED'
            activity=until(lambda:next((row for row in history(sub) if row['eventTopic']=='issues' and row['state']=='accepted'),None))
            observed=next(row for row in records() if row['deliveryId']==activity['id']);payload=json.loads(base64.b64decode(observed['bodyBase64']))
            assert payload['repository_id']==target['repositoryId'] and payload['event']=='repository.activity.issues'
            assert 'PRIVATE_ISSUE_BODY_NOT_FOR_WEBHOOK' not in json.dumps(records())
            stage('actual transient retry and accepted-before-lost-HTTP-ack duplication')
            retry=save('Retry receiver','retry');q_retry,_=queue(retry);done=terminal(retry,q_retry)
            assert done['state']=='accepted' and done['attempts']==2 and done['responseStatus']==204
            dropped=save('Dropped acknowledgement','drop');q_drop,_=queue(dropped);done=terminal(dropped,q_drop)
            assert done['state']=='accepted' and done['attempts']==2 and done.get('possibleDuplicate') is True
            repeated=[row for row in records() if row['deliveryId']==q_drop['id']]
            assert len(repeated)==2 and len({row['eventId'] for row in repeated})==1 and len({row['bodyBase64'] for row in repeated})==1
            stage('explicit redelivery stable signed event; replay does not create a second delivery')
            op=str(uuid.uuid4());redeliver={'target':target,'deliveryId':queued['id'],'expectedVersion':sub['version'],'operationId':op}
            row=target_receipt(call('admin',METHODS[4],redeliver),target)['delivery'];assert row['id']==op and row['eventId']==queued['eventId']
            assert terminal(sub,row)['state']=='accepted'
            assert target_receipt(call('admin',METHODS[4],redeliver),target)['delivery']['id']==op
            stage('actual receiver redirect refused without following the destination')
            redirect=save('Redirect refusal','redirect');q_redirect,_=queue(redirect);done=terminal(redirect,q_redirect)
            assert done['state']=='failed' and done['responseStatus']==302 and done['attempts']==1
            assert len([row for row in records() if row['deliveryId']==q_redirect['id']])==1
            stage('TLS hostname mismatch refused before receiver request bytes')
            bad_sub=save('TLS refusal');bad_sub=target_receipt(call('admin',METHODS[1],{'target':target,'id':bad_sub['id'],'expectedVersion':bad_sub['version'],'name':bad_sub['name'],'eventTopics':['issues'],'endpoint':'https://receiver-bad.golf.test'+prefix+'/accept','enabled':True,'authorizeBackground':True}),target)['subscription']
            q_bad,_=queue(bad_sub);until(lambda:next((row for row in history(bad_sub) if row['id']==q_bad['id'] and row['state']=='retrying' and row['attempts']>=1 and not row.get('responseStatus')),None))
            assert not any(row['deliveryId']==q_bad['id'] for row in records());save(bad_sub['name'],old=bad_sub,enabled=False)
            stage('stopped worker and pending delivery; current native admin removal cancels without send')
            command('stop','webhook-worker');pending,_=queue(sub)
            if screens:
                stage('actual served settings and live native-admin revocation')
                browser_config={'golf':smoke.GOLF,'native':smoke.GITEA,'repository':repository['owner']+'/'+repository['name'],'email':actors['admin']['name']+'@example.invalid','username':actors['admin']['name'],'password':actors['admin']['password'],'ownerToken':actors['owner']['token'],'endpoint':endpoint,'key':key,'prefix':prefix,'screenshots':str(screens),'runtime':baseline}
                # Worker must run for the browser's explicit test, while the pending
                # no-send proof needs a fresh queue immediately before revocation.
                command('start','webhook-worker');terminal(sub,pending)
                run('node','--input-type=module','-e',BROWSER,payload=json.dumps(browser_config),timeout=300)
                call('admin',METHODS[0],{'target':target},403)
                command('stop','webhook-worker')
                # Regrant only to enqueue an explicit frozen pending fixture. The
                # browser's preceding revocation proof remains separately recorded.
                smoke.provider(actors['owner']['token'],'PUT',route+'/collaborators/'+actors['admin']['name'],{'permission':'admin'},expected=204)
                pending,_=queue(sub)
            smoke.provider(actors['owner']['token'],'DELETE',route+'/collaborators/'+actors['admin']['name'],expected=204)
            before=len(records());command('start','webhook-worker');cancelled=terminal(sub,pending)
            assert cancelled['state']=='cancelled' and cancelled['failureCode']=='background_authority_revoked' and len(records())==before
            paused=next(row for row in list_subs() if row['id']==sub['id']);assert not paused.get('enabled') and paused['authorizationState']=='authority_unavailable'
            stage('explicit local-account disable does not resurrect consent')
            result=json.loads(command('exec','-T','golf','golf','local-account','disable',payload={'username':actors['admin']['name']}));assert result['result']['disabled']
            smoke.rpc(actors['admin']['session'],SERVICE+METHODS[0],{'target':target},expected=401)
            retained_receipts=receipt_metadata(records(),key)
            observed_deliveries=[{field:row[field] for field in ('id','subscriptionId','subscriptionVersion','eventId','eventTopic','state','attempts','responseStatus','failureCode','possibleDuplicate','createdAt','completedAt') if field in row} for subscription in list_subs() for row in history(subscription)]
            results.update(runtimeAfter=runtime(), signaturesIndependentlyVerified=True, receiverRequests=len(retained_receipts),
                           receiverReceipts=retained_receipts, deliveryReceipts=observed_deliveries,
                           logoutContinuedDelivery=True, restartNoRepost=True, activityBodyExcluded=True,
                           transientRetry=True, lostHTTPAckPossibleDuplicate=True, explicitStableEventRedelivery=True,
                           tlsHostnameDeniedBeforeBody=True, redirectsNotFollowed=True, currentAdminRevocationNoSend=True,
                           actualBrowser=bool(screens), passed=True)
            assert results['runtimeAfter']==baseline
            success=True
            print('PASS: actual queue/worker HTTPS/HMAC/retry/HTTP-ack-uncertainty, shared activity, logout/restart and current-admin fences',flush=True)
        except Exception:
            results['failureStage']=STAGE
            raise
        finally:
            if success:stage('owned fresh-stack cleanup; never retained services')
            else:print('CHECK: owned fresh-stack cleanup after bounded failure',flush=True)
            if started:
                for role,actor in actors.items():
                    try:smoke.rpc(actor['session'],'SessionService/Logout')
                    except Exception:pass  # Already revoked/disabled is expected.
                    if actor.get('enrolled'):
                        try:
                            result=json.loads(command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']}));assert result['result']['disabled']
                        except Exception:cleanup_errors.append('managed disable')
                try:command('down','--volumes','--remove-orphans',timeout=120)
                except Exception:cleanup_errors.append('fresh compose teardown')
                try:assert not command('ps','-aq')
                except Exception:cleanup_errors.append('fresh container absence')
            smoke.GOLF,smoke.GITEA=previous
            results['cleanupComplete']=not cleanup_errors
            if screens:private_write(screens/'manifest.json',json.dumps(results,indent=2)+'\n')
            assert not cleanup_errors,'Owned cleanup incomplete; fixed categories only'
    assert success
    print('PASS: fresh actors/databases/subscriptions/worker/receiver/CA removed; no retained stack or third-party endpoint modified',flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FAIL: outbound webhook qualification at '+STAGE+'; private diagnostics withheld',file=sys.stderr)
        sys.exit(1)

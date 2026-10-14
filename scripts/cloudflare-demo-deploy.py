#!/usr/bin/env python3
"""Create or resume a retained native installation, with real owners, Git and hosted CI.

Content is explicit: pass --manifest PATH (deploy/demo/example.json is a neutral sample) or --no-seed."""
import argparse
import datetime as dt
import hashlib
from http.client import RemoteDisconnected
import json
import os
import re
import secrets
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
import uuid

from cloudflare_demo_manifest import admin_identity, read_manifest
from cloudflare_setup import replace_private_json

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'golf-native-demo-python:repeatable'


def command(args, timeout=900):
    subprocess.run(list(map(str,args)),cwd=ROOT,check=True,timeout=timeout)


def build_image():
    command(['docker','build','--provenance=false','--platform','linux/amd64','-t','golf-cf-agent:demo-base','-f','cloudflare/agents/Dockerfile','cloudflare/agents'])
    command(['docker','build','--provenance=false','--platform','linux/amd64','-t',IMAGE,'deploy/demo'])


def renew_authority(receipt):
    receipt=Path(receipt).resolve();state=json.loads(receipt.read_text());directory=receipt.parent
    settings=json.loads((directory/'forge.json').read_text())
    if state.get('state') not in ['retained','needs_repair'] or not state.get('demo',{}).get('retained') or state['account']!=settings['account'] or state['name']!=settings['worker'] or state['resources']['database']['uuid']!=settings['database']['uuid']:
        raise ValueError('Use the owned retained installation receipt')
    if not re.fullmatch('[a-zA-Z0-9_-]{1,63}',state['profile']) or any(os.environ.get(k) for k in ['CLOUDFLARE_API_TOKEN','CF_API_TOKEN','CLOUDFLARE_API_KEY','CF_API_KEY']):
        raise ValueError('Use the recorded profile without ambient provider credentials')
    auth_path=directory/'retained-auth.json'
    if auth_path.is_symlink() or auth_path.stat().st_mode & 0o077:raise ValueError('Private deployment authority required')
    old=json.loads(auth_path.read_text())
    if old['origin']!=settings['origin'] or not old['token'].startswith('golf_native_'):raise ValueError('Deployment authority differs')
    def cf(*args):
        process=subprocess.run(['cf','--profile',state['profile'],*args],capture_output=True,timeout=60,env={**os.environ,'CLOUDFLARE_ACCOUNT_ID':state['account'],'CF_SEND_TELEMETRY':'false'})
        if process.returncode:raise RuntimeError('Operator authority renewal failed: '+args[0])
        return json.loads(process.stdout)
    database=cf('d1','get',settings['database']['uuid'])
    if database['uuid']!=state['resources']['database']['uuid'] or database['name']!=state['name']:raise ValueError('Owned database changed')
    def query(sql,params=()):return cf('d1','query',settings['database']['uuid'],'--body',json.dumps({'sql':sql,'params':params}))[0]['results']
    rows=query('SELECT u.id,u.active,u.can_create,a.active AS admin FROM users u JOIN operations_admins a ON a.user_id=u.id WHERE u.id=1')
    if len(rows)!=1 or not all(rows[0][k]==1 for k in ['active','can_create','admin']):raise ValueError('Retained demo operator is no longer active')
    original=state['resources']['preview_service_token'];current=cf('zero-trust','access','service-tokens','get',original['id'])
    if any(current[k]!=original[k] for k in ['id','name']):raise ValueError('Owned Access service token changed')
    cf('zero-trust','access','service-tokens','update',original['id'],'--name',original['name'],'--duration','5h')
    rotated=cf('zero-trust','access','service-tokens','rotate',original['id'])
    if any(rotated[k]!=original[k] for k in ['id','name']):raise ValueError('Rotated token identity differs')
    # Retain the rotated Access secret immediately, even if subsequent native enrollment fails.
    old.update(access_client_id=rotated['client_id'],access_client_secret=rotated['client_secret']);replace_private_json(auth_path,old)
    token='golf_native_'+secrets.token_urlsafe(32);expires=int(time.time())+18000
    query('INSERT INTO credentials(digest,user_id,expires_at) VALUES(?,1,?)',[hashlib.sha256(token.encode()).hexdigest(),expires])
    old_digest=hashlib.sha256(old['token'].encode()).hexdigest()
    replace_private_json(auth_path,{'origin':settings['origin'],'token':token,'access_client_id':rotated['client_id'],'access_client_secret':rotated['client_secret'],'expires_at':expires})
    query('UPDATE credentials SET revoked=1 WHERE digest=? AND user_id=1',[old_digest])
    print(json.dumps({'authority':'renewed','expires_at':dt.datetime.fromtimestamp(expires,dt.timezone.utc).isoformat()}))


def apply(receipt, manifest_path=None):
    """Claim the administrator's personal owner, then import the manifest's content; without a manifest only the owner is claimed."""
    receipt=Path(receipt).resolve();state=json.loads(receipt.read_text());directory=receipt.parent
    manifest=read_manifest(manifest_path) if manifest_path else None;settings=json.loads((directory/'forge.json').read_text())
    if state.get('state') not in ['retained','needs_repair'] or not state.get('demo',{}).get('retained') or state['account']!=settings['account'] or state['name']!=settings['worker']:
        raise ValueError('Use the owned retained installation receipt')
    auth_path=directory/'retained-auth.json'
    if auth_path.is_symlink() or auth_path.stat().st_mode & 0o077: raise ValueError('Private deployment authority required')
    auth=json.loads(auth_path.read_text())
    if auth['origin']!=settings['origin']:raise ValueError('Deployment authority origin differs')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args):return None
    opener=urllib.request.build_opener(NoRedirect())
    def post(path,body):
        headers={'Content-Type':'application/json','Connect-Protocol-Version':'1','User-Agent':'GolfNativeForgeQualification/1','Authorization':'Bearer '+auth['token'],
                 'CF-Access-Client-Id':auth['access_client_id'],'CF-Access-Client-Secret':auth['access_client_secret']}
        safe=path.rsplit('/',1)[-1].startswith(('Get','List')) or bool(body.get('idempotencyKey')) or body.get('action') in ['ensurePersonal','status','listMembers']
        for attempt in range(4):
            try:
                with opener.open(urllib.request.Request(auth['origin']+path,data=json.dumps(body).encode(),headers=headers),timeout=60) as response:return json.load(response)
            except urllib.error.HTTPError as error:
                if not safe or error.code<500 or attempt==3:raise RuntimeError('Demo API '+path+' returned HTTP '+str(error.code)) from None
            except (TimeoutError,RemoteDisconnected,urllib.error.URLError):
                if not safe or attempt==3:raise
            time.sleep(attempt+1)
    rpc=lambda service,method,body:post('/rpc/golf.v1.'+service+'/'+method,body)
    session=rpc('SessionService','GetSession',{})['user']
    if session['id']!='1':raise ValueError('Retained demo actor differs')
    if manifest is None:
        # Map the qualification playgrounds to the administrator's personal owner; no other content is created.
        post('/native/owners',{'action':'ensurePersonal','userId':session['id'],'expectedLogin':session['login'],'login':session['login']})
        state=json.loads(receipt.read_text());state['demo'].update(login=session['login'],organizations=[]);replace_private_json(receipt,state)
        print(json.dumps({'state':'verified','url':settings['origin'],'personal':session['login'],'content':'none','receipt':str(receipt)}),flush=True)
        return
    plan_path=directory/'demo-plan.json';manifest_hash=hashlib.sha256(Path(manifest_path).read_bytes()).hexdigest()
    plan=json.loads(plan_path.read_text()) if plan_path.exists() else {'schema':'golf.demo.plan.v1','manifest_sha256':manifest_hash,'organizations':{o['slug']:str(uuid.uuid4()) for o in manifest['organizations']}}
    if plan['manifest_sha256']!=manifest_hash:raise ValueError('Pinned demo manifest changed; inspect the original deployment plan')
    replace_private_json(plan_path,plan)
    # A manifest without a personal section keeps the administrator's own login and profile.
    personal=manifest.get('personal') or {'login':session['login']}
    if 'fullName' in personal:
        profile=rpc('ProfileService','GetProfile',{})['profile']
        rpc('ProfileService','UpdateProfile',{'userId':session['id'],'expectedRevision':profile['revision'],**{k:personal[k] for k in ['fullName','bio','website']}})
    post('/native/owners',{'action':'ensurePersonal','userId':session['id'],'expectedLogin':session['login'],'login':personal['login']})
    for organization in manifest['organizations']:
        result=post('/native/owners',{'action':'createOrganization',**organization,'idempotencyKey':plan['organizations'][organization['slug']]})
        if result['owner']['slug']!=organization['slug']:raise ValueError('Organization identity differs')
        print(json.dumps({'organization':organization['slug'],'membership':'owner'}),flush=True)
    command(['python3','scripts/cloudflare-demo-seed.py',receipt,'--manifest',manifest_path,'--ci'],timeout=2400)
    imported=json.loads((directory/'seed-receipt.json').read_text())
    selected=[next(r for r in imported['repositories'] if r['name']==spec['name']) for spec in manifest['repositories']]
    if any(r.get('state')!='verified' or r.get('ci',{}).get('state')!='verified' for r in selected):raise RuntimeError('Demo import/CI is incomplete; resume with the same receipt')
    for organization in manifest['organizations']:
        rows=rpc('RepositoryService','ListRepositories',{'owner':organization['slug'],'metadataOnly':True,'page':{'page':1,'limit':100}})['repositories']
        expected={r['name'] for r in manifest['repositories'] if r['owner']==organization['slug']}
        if {r['name'] for r in rows}!=expected:raise ValueError('Organization inventory differs')
        members=post('/native/owners',{'action':'listMembers','organization':organization['slug']})['members']
        if not any(str(m['id'])==session['id'] and m['login']==personal['login'] and m['role']=='owner' for m in members):raise ValueError('Organization membership differs')
    command(['python3','scripts/cloudflare_repository_metadata.py',directory,'--profile',state['profile'],*[arg for r in selected for arg in ['--repository',r['name']]]],timeout=900)
    state=json.loads(receipt.read_text());state['demo'].update(login=personal['login'],organizations=[o['slug'] for o in manifest['organizations']],imported_repository_ids=[r['repository_id'] for r in selected],imported_ci_verified=True,manifest_sha256=manifest_hash)
    replace_private_json(receipt,state)
    plan.update(state='verified',checked_at=dt.datetime.now(dt.timezone.utc).isoformat(),repository_count=len(selected));replace_private_json(plan_path,plan)
    print(json.dumps({'state':'verified','url':settings['origin'],'personal':personal['login'],'organizations':state['demo']['organizations'],'imported_repositories':len(selected),'receipt':str(receipt)}),flush=True)


def content_arguments(parser):
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--manifest',type=Path,help='pinned content manifest to import: deploy/demo/example.json (neutral sample) or your own; deploy/demo/mj.json is the hosted demo')
    group.add_argument('--no-seed',action='store_true',help="import no content: only the CI/preview qualification playgrounds and the administrator's personal owner")


def create_argv(args):
    """The qualification launcher arguments for a retained installation; validates inputs without contacting Cloudflare."""
    if args.manifest:read_manifest(args.manifest)
    identity=admin_identity(args.email,args.admin_login)
    argv=['python3','scripts/cloudflare-forge-smoke.py','--account-id',args.account_id,'--profile',args.profile,'--workers-subdomain',args.workers_subdomain,
          '--evidence','--container-tests','--delivery','--apps','--app-zone',args.zone_id,'--app-host',args.preview_hostname,'--demo-host',args.hostname,'--demo-email',args.email,
          '--admin-login',identity['login'],'--managed-registry','--retain-demo','--test-image',args.test_image,'--evidence-daily-limit','40']
    if args.secrets_store_id:argv+=['--secrets-store-id',args.secrets_store_id]
    return argv


def build_parser():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='action',required=True)
    sub.add_parser('build-image',help='build the reviewed linux/amd64 CI image')
    renew=sub.add_parser('renew-authority',help='renew the owned Access service token and native machine credential');renew.add_argument('receipt',type=Path)
    use=sub.add_parser('apply',help="claim the administrator's personal owner and import (or resume) manifest content");use.add_argument('receipt',type=Path);content_arguments(use)
    create=sub.add_parser('create',help='create a fresh retained installation, then apply its content')
    content_arguments(create)
    for flag,text in [('account-id','Cloudflare account ID (32 hex)'),('profile','authenticated cf CLI profile name'),('workers-subdomain','the account workers.dev subdomain'),
                      ('zone-id','zone ID (32 hex) that holds both hostnames'),('hostname','unused control hostname, such as golf.example.com'),
                      ('preview-hostname','unused preview hostname, such as golf-previews.example.com'),('email','existing Cloudflare Access email of the administrator')]:
        create.add_argument('--'+flag,required=True,help=text)
    create.add_argument('--admin-login',help='administrator Golf login; default derived from --email')
    create.add_argument('--secrets-store-id',help='existing Secrets Store ID; required when the account already has a store')
    create.add_argument('--test-image',default=IMAGE)
    return parser


def main():
    parser=build_parser();args=parser.parse_args()
    if args.action=='build-image':return build_image()
    if args.action=='renew-authority':return renew_authority(args.receipt)
    if args.action=='apply':return apply(args.receipt,args.manifest.resolve() if args.manifest else None)
    try:argv=create_argv(args)
    except ValueError as error:parser.error(str(error))
    before={p.resolve() for p in (ROOT/'.tmp/cloudflare-forge').glob('*/ownership.json')}
    command(argv,timeout=2700)
    candidates=[p for p in (ROOT/'.tmp/cloudflare-forge').glob('*/ownership.json') if p.resolve() not in before]
    owned=[p for p in candidates if (lambda s:s.get('state')=='retained' and s.get('demo',{}).get('url','').rstrip('/')=='https://'+args.hostname)(json.loads(p.read_text()))]
    if len(owned)!=1:raise RuntimeError('New retained installation receipt is ambiguous')
    apply(owned[0],args.manifest.resolve() if args.manifest else None)
    print(json.dumps({'receipt':str(owned[0]),'optional_services':'AI, search, pipelines, email and token renewal are Alchemy actions; see "Hand off to Alchemy" in deploy/demo/README.md'}),flush=True)


if __name__=='__main__':main()

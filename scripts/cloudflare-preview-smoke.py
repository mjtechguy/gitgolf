#!/usr/bin/env python3
"""Bounded actual Access/Worker/custom-domain/D1/R2 preview qualification.
Owns an isolated PostgreSQL and quick tunnel; repository/runner producer is controlled.
The collaborative T3 browser must supply browser-proof.json before this can pass.
"""
import argparse, datetime as dt, hashlib, json, os, re, secrets, shutil, signal, subprocess, time, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--account-id',required=True);parser.add_argument('--zone-id',required=True);parser.add_argument('--base-hostname',required=True);parser.add_argument('--profile',default='golf');parser.add_argument('--reviewer-email',help='Use an existing Google Access seat, explicitly bound to the fixture native reader');parser.add_argument('--reviewer-login',choices=['google','onetimepin'],default='google',help='Existing Google provider or a temporary owned email-code provider; email sending requires explicit authorization');args=parser.parse_args()
    if args.reviewer_login=='onetimepin' and not args.reviewer_email:parser.error('Email-code login requires the selected existing reviewer email')
    if not re.fullmatch('[a-f0-9]{32}',args.account_id) or not re.fullmatch('[a-f0-9]{32}',args.zone_id) or args.base_hostname!='previews.mjtechguy.com':raise SystemExit('Use the explicitly approved account/zone/preview hostname')
    if any(os.environ.get(k) for k in ('CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CF_API_TOKEN')):raise SystemExit('Use native selected-profile OAuth')
    name='golf-cf-preview-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d')+'-'+uuid.uuid4().hex[:8];deployment=str(uuid.uuid4());hostname=deployment+'.'+args.base_hostname
    root=ROOT/'.tmp/cloudflare-previews'/name;root.mkdir(parents=True,mode=0o700)
    env={**os.environ,'CLOUDFLARE_ACCOUNT_ID':args.account_id,'CF_SEND_TELEMETRY':'false','CI':'true'}
    state={'schema_version':'golf.cloudflare.preview-qualification.v1','run':name,'launcher_pid':os.getpid(),'profile':args.profile,'account':args.account_id,'zone':args.zone_id,'hostname':hostname,'state':'running','resources':{'worker':name},'events':[],'checks':{},'cleanup':{},'daily_testing_budget_usd':10,'source_sha256':{}}
    for path in [Path(__file__).resolve(),*sorted((ROOT/'cloudflare/previews').rglob('*.mjs')),*[ROOT/'internal/server'/p for p in ['access_oidc.go','cloudflare_preview.go','preview_access.go','preview_config.go','preview_static.go','cloudflare_preview_live_test.go','cloudflare_preview_test.go','access_oidc_test.go','server.go','repository_deployments.go','deployment_approvals.go']],ROOT/'internal/server/database/migrations/202610080094_access_oidc.sql', *[ROOT/p for p in ['web/src/App.tsx','web/src/ArtifactDeployment.tsx','web/src/deploymentReads.ts','api/golf/v1/golf.proto']]]:state['source_sha256'][str(path.relative_to(ROOT))]=hashlib.sha256(path.read_bytes()).hexdigest()
    processes=[];redactions=[];pg=name+'-pg';created_worker=False;owned_object=False
    def save():path=root/'ownership.json';path.write_text(json.dumps(state,indent=2)+'\n');path.chmod(0o600)
    def private(name,value):path=root/name;path.write_text(json.dumps(value));path.chmod(0o600)
    def run(label,argv,environment=env,cwd=ROOT,timeout=60,required=True):
        state['events'].append({'operation':label,'state':'dispatching'});save();p=subprocess.Popen(argv,cwd=cwd,env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        try:out,err=p.communicate(timeout=timeout)
        except BaseException:
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            p.communicate();raise
        state['events'][-1].update(state='acknowledged',exit_code=p.returncode);save()
        if required and p.returncode:
            raw=out+err
            for secret in redactions:raw=raw.replace(secret.encode(),b'[withheld]')
            path=root/'failure.log';path.write_bytes(raw);path.chmod(0o600);raise RuntimeError(label+' failed; inspect private redacted diagnostics')
        return subprocess.CompletedProcess(argv,p.returncode,out,err)
    def cf(label,*values,required=True):
        result=run(label,['cf','--profile',args.profile,*values],required=required)
        if result.returncode:return None
        value=json.loads(result.stdout) if result.stdout.strip() else None
        return value.get('result',value) if isinstance(value,dict) else value
    def wait(name,timeout=90):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            path=root/name
            if path.exists():return path.read_bytes()
            if any(p.poll() is not None for p in processes):raise RuntimeError('owned runtime stopped before '+name)
            time.sleep(.2)
        raise RuntimeError(name+' deadline')
    def stop(p):
        try:os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            p.wait(timeout=5)
        try:os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError:pass
    def helper(mode):return json.loads(run('native Worker domain '+mode,['node','cloudflare/previews/prepare.mjs',str(root),shutil.which('cf'),mode]).stdout)
    def interrupted(*_):raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM,interrupted);save()
    try:
        who=cf('selected native OAuth account','auth','whoami')
        if not who.get('authenticated') or not who.get('tokenValid') or not who.get('authSource','').endswith('/'+args.profile+'.json') or args.account_id not in [a['id'] for a in who.get('accounts',[])]:raise RuntimeError('selected account unavailable')
        zone=cf('approved zone','zones','get','--zone',args.zone_id)
        if zone.get('account',{}).get('id')!=args.account_id or zone.get('name')!='mjtechguy.com' or zone.get('status')!='active':raise RuntimeError('approved zone mismatch')
        if cf('destination collision check','dns','records','list','--zone',args.zone_id,'--name',hostname):raise RuntimeError('preview hostname already exists')
        organization=cf('existing Access organization','zero-trust','organization','get');team=organization['auth_domain']
        external_provider=None
        if args.reviewer_email:
            users=cf('selected existing Access seat','zero-trust','access','users','list','--email',args.reviewer_email,'--per-page','100')
            if not any(u.get('email')==args.reviewer_email and u.get('access_seat') for u in users):raise RuntimeError('Selected reviewer has no existing Access seat')
            state['reviewer_mode']=args.reviewer_login+'_identity_bound_to_native_reader'
            if args.reviewer_login=='google':
                providers=cf('existing Google identity provider','zero-trust','identity-providers','list');google=[p for p in providers if p.get('type')=='google']
                if len(google)!=1:raise RuntimeError('Expected one existing Google identity provider')
                external_provider=google[0]['id'];state['borrowed_identity_provider']=external_provider
            save()
        pg_env={**env,'POSTGRES_PASSWORD':secrets.token_urlsafe(24)}
        run('owned PostgreSQL start',['docker','run','-d','--rm','--name',pg,'--memory','384m','--cpus','1','-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:18.4-alpine3.24'],environment=pg_env)
        deadline=time.monotonic()+30
        while run('database readiness',['docker','exec',pg,'pg_isready','-U','postgres'],required=False).returncode:
            if time.monotonic()>deadline:raise RuntimeError('database readiness deadline')
            time.sleep(.2)
        port=run('owned database port',['docker','port',pg,'5432/tcp']).stdout.decode().strip().rsplit(':',1)[1]
        testenv={**env,'GOLF_TEST_DATABASE_URL':'postgres://postgres:'+pg_env['POSTGRES_PASSWORD']+'@127.0.0.1:'+port+'/postgres?sslmode=disable','GOLF_CF_PREVIEW_LIVE_DIRECTORY':str(root),'GOLF_CF_PREVIEW_TEAM_DOMAIN':team}
        output=(root/'handler.log').open('wb');(root/'handler.log').chmod(0o600)
        p=subprocess.Popen(['go','test','-race','./internal/server','-run','^TestCloudflarePreviewLive$','-count=1','-v','-timeout','18m'],cwd=ROOT,env=testenv,stdout=output,stderr=subprocess.STDOUT,start_new_session=True);processes.append(p)
        listener=json.loads(wait('listener.json'))['url'];tunnel_log=(root/'tunnel.log').open('w+b');(root/'tunnel.log').chmod(0o600)
        tunnel=subprocess.Popen(['cf','--profile',args.profile,'tunnels','quick-start',listener],cwd=ROOT,env=env,stdout=tunnel_log,stderr=subprocess.STDOUT,start_new_session=True);processes.append(tunnel)
        deadline=time.monotonic()+60;origin=None
        while time.monotonic()<deadline:
            match=re.search(rb'https://[a-z0-9-]+\.trycloudflare\.com',(root/'tunnel.log').read_bytes())
            if match:origin=match[0].decode();break
            if tunnel.poll() is not None:break
            time.sleep(.2)
        if not origin:raise RuntimeError('owned HTTPS tunnel unavailable')
        (root/'origin').write_text(origin);state['origin']=origin;save()
        issuer=json.loads(wait('issuer.json'));redactions.append(issuer['client_secret'])
        if external_provider:
            provider={'id':external_provider}
        elif args.reviewer_email and args.reviewer_login=='onetimepin':
            provider=cf('owned temporary email-code provider','zero-trust','identity-providers','create','--body',json.dumps({'name':name,'type':'onetimepin','config':{}}));state['resources']['identity_provider']={'id':provider['id'],'name':provider['name']};save()
        else:
            provider=cf('owned Golf OIDC provider','zero-trust','identity-providers','create','--body',json.dumps({'name':name,'type':'oidc','config':{'client_id':issuer['client_id'],'client_secret':issuer['client_secret'],'auth_url':issuer['issuer']+'/authorize','token_url':issuer['issuer']+'/token','certs_url':issuer['issuer']+'/jwks','pkce_enabled':True,'email_claim_name':'email','scopes':['openid','email','profile']}}));state['resources']['identity_provider']={'id':provider['id'],'name':provider['name']};save()
        machine=cf('twenty-minute machine health credential','zero-trust','access','service-tokens','create','--name',name,'--duration','20m');redactions.append(machine['client_secret']);state['resources']['service_token']={'id':machine['id'],'name':machine['name']};save()
        reviewer_policy={'name':'Golf reviewers','decision':'allow','include':[{'login_method':{'id':provider['id']}}]}
        if args.reviewer_email:reviewer_policy={'name':'Existing Google reviewer','decision':'allow','include':[{'email':{'email':args.reviewer_email}}],'require':[{'login_method':{'id':provider['id']}}]}
        app=cf('Access before custom domain publication','zero-trust','access','applications','create','--body',json.dumps({'name':name,'type':'self_hosted','domain':hostname,'session_duration':'15m','allowed_idps':[provider['id']],'auto_redirect_to_identity':True,'policies':[reviewer_policy,{'name':'Owned machine health','decision':'non_identity','include':[{'service_token':{'token_id':machine['id']}}]}]}));state['resources']['application']={'id':app['id'],'aud':app['aud'],'name':app['name']};save()
        d1=cf('owned D1 create','d1','create','--name',name);state['resources']['d1']={'uuid':d1['uuid'],'name':d1['name']};save()
        r2=cf('owned private R2 create','r2','buckets','create','--name',name);state['resources']['r2']={'name':r2['name'],'creation_date':r2['creation_date']};save()
        broker=secrets.token_urlsafe(32);redactions.append(broker)
        preview_config={'base_url':'https://'+args.base_hostname,'deployment_id':deployment,'account_id':args.account_id,'d1_id':d1['uuid'],'r2_bucket':r2['name'],'r2_created':r2['creation_date'],'access_aud':app['aud'],'broker_secret':broker,'probe_client_id':machine['client_id'],'probe_client_secret':machine['client_secret']}
        if args.reviewer_email:preview_config.update(access_reviewer_native_id=42,access_reviewer_email=args.reviewer_email)
        private('preview-config.json',preview_config)
        prepared=json.loads(wait('prepared.json'));state['prepared']=prepared;state['object_key']='qualification/'+prepared['archive'];save()
        cf('upload exact retained artifact','r2','objects','put',state['object_key'],'--bucket-name',name,'--file',str(root/'artifact.tar'));owned_object=True
        run('native protected preview build',['node','cloudflare/previews/prepare.mjs',str(root),shutil.which('cf')])
        private('worker-secrets.json',{'GOLF_BROKER_SECRET':broker})
        run('native Worker custom-domain deployment',['cf','--profile',args.profile,'deploy','--prebuilt','--provision','false','--secrets-file',str(root/'worker-secrets.json')],cwd=root,timeout=120);created_worker=True;(root/'worker-secrets.json').unlink(missing_ok=True)
        workers=cf('acknowledged Worker identity','workers','list','--per-page','100');rows=workers.get('result',workers) if isinstance(workers,dict) else workers;selected=[r for r in rows if r['name']==name]
        if len(selected)!=1:raise RuntimeError('exact Worker readback unavailable')
        state['resources']['worker_id']=selected[0]['id'];save()
        domains=helper('domains');rows=domains.get('result',domains) if isinstance(domains,dict) else domains;selected=[r for r in rows if r['hostname']==hostname and r['service']==name and r['zone_id']==args.zone_id]
        if len(selected)!=1:raise RuntimeError('exact Worker custom domain unavailable')
        state['resources']['domain']=selected[0];save()
        # Native domain certificates can take a short time; only side-effect-free
        # checks receive a readiness window. Golf activation still fails closed.
        import urllib.request, urllib.error
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*_):return None
        opener=urllib.request.build_opener(NoRedirect)
        deadline=time.monotonic()+300
        next_certificate_check=0
        while time.monotonic()<deadline:
            try:
                request=urllib.request.Request('https://'+hostname+'/__golf/health',headers={'User-Agent':'Golf/0.1 (protected-preview qualification)','Accept':'application/json','CF-Access-Client-Id':machine['client_id'],'CF-Access-Client-Secret':machine['client_secret'],'Authorization':'Bearer '+broker})
                with opener.open(request,timeout=10) as response:
                    if json.load(response).get('fingerprint')==prepared['fingerprint']:break
            except urllib.error.HTTPError as error:
                state['checks']['last_health']={'status':error.code}
            except Exception as error:
                state['checks']['last_health']={'error_type':type(error).__name__,'reason_type':type(getattr(error,'reason',None)).__name__}
            if time.monotonic()>=next_certificate_check:
                certificate=cf('native certificate readiness','ssl','certificate-packs','get',state['resources']['domain']['cert_id'],'--zone',args.zone_id,required=False)
                state['checks']['certificate']={k:certificate.get(k) for k in ['status','validation_method','validation_errors']} if isinstance(certificate,dict) else {'status':'unavailable'}
                next_certificate_check=time.monotonic()+20
                save()
            time.sleep(2)
        else:raise RuntimeError('native TLS/Access/binding readiness deadline')
        (root/'worker-ready').touch();ready=json.loads(wait('ready.json',30));state['checks']['native_activation']=ready;save();print(json.dumps({'state':'browser_ready','receipt':str(root/'ownership.json'),'origin':origin,'preview':prepared['preview'],'deployment':deployment}),flush=True)
        wait('stop',350);p.wait(timeout=20);output.close()
        proof=root/'browser-proof.json'
        if p.returncode or not proof.exists() or json.loads(proof.read_text()).get('state')!='passed':raise RuntimeError('independent collaborative browser proof missing or handler failed')
        state['checks']['browser']=json.loads(proof.read_text());state['state']='passed'
    except (Exception,KeyboardInterrupt) as error:state['state']='failed';state['failure']=str(error) if isinstance(error,RuntimeError) else type(error).__name__+'; private diagnostics withheld'
    finally:
        for p in reversed(processes):stop(p)
        state['cleanup']['quick_tunnel']='stopped'
        def cleanup(label,action):
            try:action();state['cleanup'][label]='removed'
            except Exception:state['cleanup'][label]='unconfirmed';state['state']='failed'
            save()
        resources=state['resources']
        if resources.get('domain'):cleanup('domain',lambda:helper('remove-domain'))
        if created_worker and resources.get('worker_id'):cleanup('worker',lambda:cf('owned Worker delete','workers','delete',resources['worker_id'],'--force'))
        if owned_object:
            def remove_object():
                original=resources['r2'];current=cf('original artifact bucket identity','r2','buckets','get',original['name'])
                if current['name']!=original['name'] or current['creation_date']!=original['creation_date']:raise RuntimeError('Artifact bucket was replaced')
                cf('owned artifact object delete','r2','objects','delete',state['object_key'],'--bucket-name',original['name'],'--force')
            cleanup('r2_object',remove_object)
        if resources.get('r2'):
            def remove_r2():
                original=resources['r2'];current=cf('original R2 identity','r2','buckets','get',original['name'])
                if current['name']!=original['name'] or current['creation_date']!=original['creation_date']:raise RuntimeError('R2 was replaced')
                cf('owned R2 delete','r2','buckets','delete',original['name'],'--force')
            cleanup('r2',remove_r2)
        if resources.get('d1'):
            def remove_d1():
                original=resources['d1'];current=cf('original D1 identity','d1','get',original['uuid'])
                if current['uuid']!=original['uuid'] or current['name']!=original['name']:raise RuntimeError('D1 identity changed')
                cf('owned D1 delete','d1','delete',original['uuid'],'--force')
            cleanup('d1',remove_d1)
        if resources.get('application'):cleanup('application',lambda:cf('owned Access app delete','zero-trust','access','applications','delete',resources['application']['id'],'--force'))
        if resources.get('identity_provider'):cleanup('identity_provider',lambda:cf('owned Golf IdP delete','zero-trust','identity-providers','delete',resources['identity_provider']['id'],'--force'))
        if resources.get('service_token'):cleanup('service_token',lambda:cf('owned machine token delete','zero-trust','access','service-tokens','delete',resources['service_token']['id'],'--force'))
        for label,values in [('worker',['workers','get',resources.get('worker_id','')]),('d1',['d1','get',resources.get('d1',{}).get('uuid','')]),('r2',['r2','buckets','get',resources.get('r2',{}).get('name','')]),('application',['zero-trust','access','applications','get',resources.get('application',{}).get('id','')]),('identity_provider',['zero-trust','identity-providers','get',resources.get('identity_provider',{}).get('id','')]),('service_token',['zero-trust','access','service-tokens','get',resources.get('service_token',{}).get('id','')])]:
            if not values[-1]:continue
            observation=run('independent '+label+' absence',['cf','--profile',args.profile,*values],required=False)
            if observation.returncode!=0 and b'404 Not Found' in observation.stderr:state['cleanup'][label]='absent'
            else:state['cleanup'][label]='unconfirmed';state['state']='failed'
        try:
            dns=cf('owned DNS absence','dns','records','list','--zone',args.zone_id,'--name',hostname)
            domains=helper('domains');rows=domains.get('result',domains) if isinstance(domains,dict) else domains
            if dns or any(r['hostname']==hostname for r in rows):raise RuntimeError('preview routing remains')
            state['cleanup']['domain']='absent';state['cleanup']['dns']='absent'
        except Exception:state['cleanup']['domain']='unconfirmed';state['state']='failed'
        result=run('owned PostgreSQL stop',['docker','stop',pg],required=False);state['cleanup']['postgres']='stopped' if result.returncode==0 or run('database absence',['docker','inspect',pg],required=False).returncode else 'unconfirmed'
        if any(value=='unconfirmed' for value in state['cleanup'].values()):state['state']='failed'
        for path in ('issuer.json','preview-config.json','worker-secrets.json'): (root/path).unlink(missing_ok=True)
        save()
    print(json.dumps({'state':state['state'],'receipt':str(root/'ownership.json'),'cleanup':state['cleanup']}),flush=True);return 0 if state['state']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())

#!/usr/bin/env python3
"""Disposable Golf Cloudflare resource qualification; stops every owned runtime.
Default: isolated PostgreSQL and controlled provider boundary/race tests.
--live: native OAuth mints one account-scoped D1/R2 credential for real Golf RPCs.
--browser: real Golf handlers behind an owned temporary HTTPS quick tunnel;
controlled native repository identity, no live provider credential in that server.
"""
import argparse, datetime as dt, hashlib, json, os, re, secrets, signal, subprocess, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group();mode.add_argument('--live',action='store_true');mode.add_argument('--browser',action='store_true')
    parser.add_argument('--account-id');parser.add_argument('--profile',default='golf')
    args=parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,62}',args.profile) or args.live and not re.fullmatch(r'[a-f0-9]{32}',args.account_id or ''):parser.error('provide a named profile and canonical live account ID')
    if any(os.getenv(k) for k in ['CLOUDFLARE_API_TOKEN','CF_API_TOKEN','CLOUDFLARE_API_KEY','CF_API_KEY','CLOUDFLARE_EMAIL','CF_EMAIL']):parser.error('remove credential overrides before native profile qualification')
    name='golf-cf-product-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d')+'-'+secrets.token_hex(4)
    directory=ROOT/'.tmp/cloudflare-product'/name;directory.mkdir(parents=True,mode=0o700)
    env={**os.environ,'CF_SEND_TELEMETRY':'false','CI':'true'}
    if args.account_id:env['CLOUDFLARE_ACCOUNT_ID']=args.account_id
    state={'schema_version':'golf.cloudflare.product-qualification.v1','run':name,'mode':'live' if args.live else 'browser' if args.browser else 'source','state':'running','events':[],'cleanup':{},'daily_testing_budget_usd':10,'source_sha256':{}}
    for p in [Path(__file__).resolve(),ROOT/'internal/cloudflare/resources.go',ROOT/'internal/cloudflare/management.go',ROOT/'internal/server/cloudflare_resources.go',ROOT/'internal/server/cloudflare_resources_test.go',ROOT/'internal/server/infrastructure_connections.go',ROOT/'internal/server/database/migrations/202610080093_cloudflare_resources.sql',ROOT/'web/src/CloudflareEnvironmentResources.tsx',ROOT/'web/src/InfrastructureConnections.tsx', *[ROOT/'internal/server'/name for name in ['access_oidc.go','access_oidc_test.go','cloudflare_preview.go','cloudflare_preview_test.go','preview_access.go','preview_config.go','server.go','repository_deployments.go','deployment_approvals.go']], ROOT/'internal/server/database/migrations/202610080094_access_oidc.sql']:
        state['source_sha256'][str(p.relative_to(ROOT))]=hashlib.sha256(p.read_bytes()).hexdigest()
    pg=name+'-pg';processes=[];parent=None;groups=[];redactions=[]
    def interrupted(signum, frame):raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM,interrupted)
    def save():
        path=directory/'ownership.json';path.write_text(json.dumps(state,indent=2)+'\n');path.chmod(0o600)
    def run(label,argv,environment=env,timeout=60,required=True):
        started=time.monotonic()
        p=subprocess.Popen(argv,cwd=ROOT,env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        try:out,err=p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL);p.communicate();raise RuntimeError(label+' deadline expired') from None
        except BaseException:
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            p.communicate();raise
        state['events'].append({'operation':label,'exit_code':p.returncode,'seconds':round(time.monotonic()-started,3)});save()
        if required and p.returncode:raise RuntimeError(label+' failed; provider diagnostics withheld')
        return subprocess.CompletedProcess(argv,p.returncode,out,err)
    def cf(label,*values,environment=env,required=True):
        prefix=['cf','--profile',args.profile] if environment is env else ['cf']
        p=run(label,[*prefix,*values],environment=environment,required=required)
        return json.loads(p.stdout) if p.returncode==0 and p.stdout.strip() else None
    def log(filename,result):
        raw=result.stdout+result.stderr
        for secret in redactions:raw=raw.replace(secret.encode(),b'[withheld]')
        path=directory/filename;path.write_bytes(raw);path.chmod(0o600)
    def absence(label,*values):
        result=run(label,['cf','--profile',args.profile,*values],required=False)
        return result.returncode!=0 and b'404 Not Found' in result.stderr
    def stop(p):
        # Kill the original command's complete process group, including native
        # cloudflared. Do not signal any runtime outside this invocation.
        try:os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            p.wait(timeout=5)
        try:os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError:pass
    save()
    try:
        if args.live:
            identity=cf('selected native OAuth account','auth','whoami')
            if not identity.get('authenticated') or not identity.get('tokenValid') or not identity.get('authSource','').endswith('/'+args.profile+'.json') or args.account_id not in [a['id'] for a in identity.get('accounts',[])]:raise RuntimeError('selected OAuth account unavailable')
        pg_env={**env,'POSTGRES_PASSWORD':secrets.token_urlsafe(24)}
        run('owned PostgreSQL start',['docker','run','-d','--rm','--name',pg,'--memory','384m','--cpus','1','-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:18.4-alpine3.24'],environment=pg_env)
        deadline=time.monotonic()+30
        while run('owned PostgreSQL readiness',['docker','exec',pg,'pg_isready','-U','postgres'],required=False).returncode:
            if time.monotonic()>deadline:raise RuntimeError('database readiness expired')
            time.sleep(.25)
        port=run('owned PostgreSQL port',['docker','port',pg,'5432/tcp']).stdout.decode().strip().rsplit(':',1)[1]
        testenv={**env,'GOLF_TEST_DATABASE_URL':'postgres://postgres:'+pg_env['POSTGRES_PASSWORD']+'@127.0.0.1:'+port+'/postgres?sslmode=disable'}
        if args.live:
            groups=cf('native permission discovery','user','tokens','permission-groups','list')
            selected=[g for g in groups if g['name'] in ['D1 Write','Workers R2 Storage Write'] and g.get('is_selectable')]
            if len(selected)!=2:raise RuntimeError('scoped D1/R2 permissions unavailable')
            policy=[{'effect':'allow','resources':{'com.cloudflare.api.account.'+args.account_id:'*'},'permission_groups':[{'id':g['id']} for g in selected]}]
            expiry=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=20)).strftime('%Y-%m-%dT%H:%M:%SZ')
            parent=cf('twenty-minute D1/R2 qualification credential','user','tokens','create','--name',name,'--expires-on',expiry,'--policies',json.dumps(policy))
            redactions.append(parent['value']);state['token_id']=parent['id'];state['account']=args.account_id;save()
            receipt=directory/'live-resources.json'
            liveenv={**testenv,'GOLF_CF_PRODUCT_LIVE':'1','GOLF_CF_PRODUCT_LIVE_ACCOUNT':args.account_id,'GOLF_CF_PRODUCT_LIVE_API_TOKEN':parent['value'],'GOLF_CF_PRODUCT_LIVE_RECEIPT':str(receipt)}
            result=run('live production Golf resource RPCs',['go','test','-race','./internal/server','-run','^TestCloudflareResourceLive$','-count=1','-v','-timeout','3m'],environment=liveenv,timeout=190,required=False);log('live-check.log',result)
            if receipt.exists():state['resources']=json.loads(receipt.read_text());save()
            if result.returncode or state.get('resources',{}).get('state')!='REMOVED':raise RuntimeError('live resource qualification or cleanup failed; inspect private receipt')
            resource=state['resources']
            if not absence('independent D1 absence','d1','get',resource['d1Id']) or not absence('independent R2 absence','r2','buckets','get',resource['r2Bucket']):raise RuntimeError('independent provider absence unconfirmed')
            state['cleanup']['d1']=state['cleanup']['r2']='absent'
        elif args.browser:
            if not (ROOT/'web/dist/index.html').is_file():raise RuntimeError('build web/dist before browser qualification')
            output=(directory/'browser-handler.log').open('wb');output_path=directory/'browser-handler.log';output_path.chmod(0o600)
            p=subprocess.Popen(['go','test','./internal/server','-run','^TestCloudflareConnectionBrowser$','-count=1','-v','-timeout','7m'],cwd=ROOT,env={**testenv,'GOLF_CF_PRODUCT_BROWSER':str(directory)},stdout=output,stderr=subprocess.STDOUT,start_new_session=True);processes.append(p)
            deadline=time.monotonic()+90
            listener=directory/'browser-listener.json'
            while not listener.exists():
                if p.poll() is not None or time.monotonic()>deadline:raise RuntimeError('browser fixture readiness failed')
                time.sleep(.25)
            tunnel_log=(directory/'tunnel.log').open('w+b');(directory/'tunnel.log').chmod(0o600)
            local=json.loads(listener.read_text())['url']
            tunnel=subprocess.Popen(['cf','--profile',args.profile,'tunnels','quick-start',local],cwd=ROOT,env=env,stdout=tunnel_log,stderr=subprocess.STDOUT,start_new_session=True);processes.append(tunnel)
            deadline=time.monotonic()+60;origin=None
            while time.monotonic()<deadline:
                tunnel_log.flush();raw=(directory/'tunnel.log').read_bytes();match=re.search(rb'https://[a-z0-9-]+\.trycloudflare\.com',raw)
                if match:origin=match[0].decode();break
                if tunnel.poll() is not None:break
                time.sleep(.25)
            if origin is None:raise RuntimeError('temporary HTTPS tunnel unavailable')
            (directory/'browser-origin').write_text(origin);(directory/'browser-origin').chmod(0o600)
            ready=directory/'browser-ready.json';deadline=time.monotonic()+30
            while not ready.exists():
                if p.poll() is not None or time.monotonic()>deadline:raise RuntimeError('HTTPS browser application unavailable')
                time.sleep(.25)
            state['browser']=json.loads(ready.read_text());save();print(json.dumps({'state':'browser_ready','url':origin,'evidence':str(directory),'stop_file':str(directory/'browser-stop')}),flush=True)
            p.wait(timeout=330);output.close()
            if p.returncode:raise RuntimeError('browser fixture ended before explicit qualification stop')
            stop(tunnel);tunnel_log.close();state['cleanup']['quick_tunnel']='stopped'
            # A served fixture alone is not a browser acceptance claim. The
            # collaborative browser writes its independent observations here.
            proof=directory/'browser-proof.json'
            if not proof.exists() or json.loads(proof.read_text()).get('state')!='passed':raise RuntimeError('collaborative browser acceptance receipt missing')
            state['browser']['qualification']=json.loads(proof.read_text())
        else:
            result=run('PostgreSQL authority and provider boundary checks',['go','test','-race','./internal/cloudflare','./internal/server','-run','TestAccessOIDC|TestCloudflarePreview|TestStaticPreviewAccessSessionAndEnvironmentPostgres|TestStaticPreviewConfigurationAndTokens|TestCloudflareResourceOperationsPostgres|TestInfrastructureCloudflareProfilePostgres|TestInfrastructureProfileHistoryPostgres|TestInfrastructureDatabasePingPostgres|TestInfrastructureBrowserBoundary|TestInfrastructureCloudflareValidation|TestResourceClientBoundary|TestManagementInspectionBoundary','-count=1','-v','-timeout','4m'],environment=testenv,timeout=250,required=False);log('source-check.log',result)
            if result.returncode:raise RuntimeError('source qualification failed; inspect private check log')
        state['state']='passed'
    except (Exception,KeyboardInterrupt) as error:
        state['state']='failed';state['failure']=str(error) if isinstance(error,RuntimeError) else type(error).__name__+'; private diagnostics withheld'
    finally:
        for p in reversed(processes):stop(p)
        if args.browser:state['cleanup']['quick_tunnel']='stopped'
        if args.live and parent:
            # Recovery can delete only identities acknowledged in this owned
            # original receipt. Never adopt a discovery result after a lost ack.
            try:
                receipt=directory/'live-resources.json'
                resource=json.loads(receipt.read_text())
                operation=resource['operationId']
                expected='golf-env-'+operation.replace('-','')
                if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',operation) or resource.get('accountId')!=args.account_id or resource.get('d1Name')!=expected or resource.get('r2Bucket')!=expected:raise RuntimeError('original recovery ownership unavailable')
                state['resources']=resource;save()
                if resource.get('d1Id'):
                    identifier=resource['d1Id']
                    if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',identifier):raise RuntimeError('original D1 identity unavailable')
                    if not absence('recovery D1 absence','d1','get',identifier):
                        found=cf('recovery exact acknowledged D1','d1','get',identifier)
                        if found.get('uuid')!=identifier or found.get('name')!=expected:raise RuntimeError('D1 identity changed; deletion refused')
                        cf('recovery exact owned D1 deletion','d1','delete',identifier,'--force')
                    state['cleanup']['d1']='absent' if absence('recovery independent D1 absence','d1','get',identifier) else 'unconfirmed'
                else:state['cleanup']['d1']='not_dispatched' if resource.get('d1State')=='PLANNED' else 'unconfirmed'
                if absence('recovery R2 absence','r2','buckets','get',expected):state['cleanup']['r2']='absent'
                else:
                    found=cf('recovery exact acknowledged R2','r2','buckets','get',expected)
                    if not resource.get('r2CreatedAt') or found.get('name')!=expected or found.get('creation_date')!=resource['r2CreatedAt']:raise RuntimeError('R2 acknowledgement unavailable or identity changed; deletion refused')
                    cf('recovery exact owned empty R2 deletion','r2','buckets','delete',expected,'--force')
                    state['cleanup']['r2']='absent' if absence('recovery independent R2 absence','r2','buckets','get',expected) else 'unconfirmed'
            except Exception:
                state['cleanup'].setdefault('d1','unconfirmed');state['cleanup'].setdefault('r2','unconfirmed')
        result=run('owned PostgreSQL stop',['docker','rm','-f',pg],required=False)
        state['cleanup']['postgres']='stopped' if result.returncode==0 or b'No such container' in result.stderr else 'unconfirmed'
        if parent:
            cleanup=None
            try:
                user=cf('cleanup identity','user','get')
                selected=[g for g in groups if g['name'] in ['API Tokens Read','API Tokens Write'] and g.get('is_selectable')]
                if len(selected)!=2:raise RuntimeError('cleanup permissions unavailable')
                policy=[{'effect':'allow','resources':{'com.cloudflare.api.user.'+user['id']:'*'},'permission_groups':[{'id':g['id']} for g in selected]}]
                expiry=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ')
                cleanup=cf('five-minute cleanup credential','user','tokens','create','--name',name+'-cleanup','--expires-on',expiry,'--policies',json.dumps(policy));redactions.append(cleanup['value'])
                cleanupenv={**env,'CLOUDFLARE_API_TOKEN':cleanup['value']}
                cf('revoke exact product credential','user','tokens','delete',parent['id'],'--force',environment=cleanupenv)
                result=run('product credential absence',['cf','user','tokens','get',parent['id']],environment=cleanupenv,required=False)
                state['cleanup']['token']='absent' if result.returncode and b'404 Not Found' in result.stderr else 'unconfirmed'
            except Exception:state['cleanup']['token']='unconfirmed'
            finally:
                if cleanup:
                    try:
                        cf('cleanup credential self-revoke','user','tokens','delete',cleanup['id'],'--force',environment=cleanupenv)
                        result=run('self-revoked credential denied',['cf','user','tokens','verify'],environment=cleanupenv,required=False)
                        state['cleanup']['cleanup_token']='revoked' if result.returncode and b'401 Unauthorized' in result.stderr else 'unconfirmed'
                    except Exception:state['cleanup']['cleanup_token']='unconfirmed'
        state['finished_at']=dt.datetime.now(dt.timezone.utc).isoformat();save()
    print(json.dumps({'state':state['state'],'receipt':str(directory/'ownership.json'),'cleanup':state['cleanup']}),flush=True)
    return 0 if state['state']=='passed' and 'unconfirmed' not in state['cleanup'].values() else 1


if __name__=='__main__':raise SystemExit(main())

#!/usr/bin/env python3
"""Actual native importer fidelity probe; only called by the owned fixture harness."""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import secrets
import time
import tempfile
import subprocess
from unittest.mock import patch
import urllib.request
import smoke

spec=importlib.util.spec_from_file_location('migration',Path(__file__).with_name('forgejo-migrate.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def main():
    source_url=os.environ['GOLF_MIGRATION_FIXTURE_SOURCE']
    clone_url=os.environ['GOLF_MIGRATION_FIXTURE_CLONE']
    source_container=os.environ['GOLF_MIGRATION_FIXTURE_CONTAINER']
    assert source_container.startswith('golf-forgejo-proof-') and os.environ['GOLF_SMOKE_FORGE_CONTAINER'].startswith('golf-forgejo-proof-')
    source_users=[];target_users=[]
    try:
        def source_admin(*args):return smoke.command('docker','exec',source_container,'gitea','--config','/etc/gitea/app.ini','admin','user',*args)
        name='golf-transfer-'+secrets.token_hex(5)
        source_admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');source_users.append(name)
        source_token=source_admin('generate-access-token','--username',name,'--token-name','migration','--scopes','all','--raw')
        smoke.admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');target_users.append(name)
        target_token=smoke.admin('generate-access-token','--username',name,'--token-name','migration','--scopes','all','--raw')
        source=m.API(source_url,source_token);target=m.API(smoke.GITEA,target_token)
        repo=source.request('POST','/user/repos',{'name':'fidelity','private':True,'auto_init':True,'default_branch':'main'})
        base='/repos/'+name+'/fidelity'
        source.request('POST',base+'/contents/binary.dat',{'content':base64.b64encode(bytes(range(256))).decode(),'message':'Binary source'})
        source.request('POST',base+'/issues',{'title':'Open source issue','body':'Original body'})
        source.request('POST',base+'/issues/1/comments',{'body':'Original comment'})
        source.request('POST',base+'/branches',{'new_branch_name':'feature','old_branch_name':'main'})
        source.request('POST',base+'/contents/change.txt',{'branch':'feature','content':base64.b64encode(b'change\n').decode(),'message':'PR source'})
        pull=source.request('POST',base+'/pulls',{'title':'Open source PR','body':'Original PR body','head':'feature','base':'main'})
        # Pending own reviews are privacy-sensitive; importer support must be proven.
        source.request('POST',base+'/pulls/'+str(pull['number'])+'/reviews',{'event':'PENDING','body':'Private pending draft'})
        source.request('POST',base+'/labels',{'name':'migration','color':'123456','description':'Owned label'})
        source.request('POST',base+'/milestones',{'title':'First milestone','description':'Owned milestone'})
        # Let asynchronous source hooks finish before taking the frozen baseline.
        time.sleep(2)
        before=m.snapshot(source,name+'/fidelity')
        with tempfile.TemporaryDirectory(prefix='golf-transfer-journal-') as temporary:
            private=Path(temporary)
            key=private/'age.key'
            smoke.command('age-keygen','-o',str(key))
            recipient=smoke.command('age-keygen','-y',str(key))
            args=argparse.Namespace(phase='plan',journal=private/'journal.json',source=source_url,target=smoke.GITEA,
                repository=name+'/fidelity',owner=name,archive=private/'inventory.age',recipient=recipient,
                source_frozen=True,target_quarantined=True)
            original_request=m.API.request
            def fixture_request(api,method,path,payload=None,allow_missing=False):
                # Only the owned Docker importer needs the source's network alias;
                # the operator APIs and all transfer logic use their real origins.
                if method=='POST' and path=='/repos/migrate':
                    assert payload['clone_addr']==source_url+'/'+name+'/fidelity'
                    payload={**payload,'clone_addr':clone_url+'/'+name+'/fidelity'}
                return original_request(api,method,path,payload,allow_missing)
            with patch.dict(os.environ,{'GOLF_MIGRATION_SOURCE_TOKEN':source_token,'GOLF_MIGRATION_TARGET_TOKEN':target_token}),patch.object(m.API,'request',fixture_request):
                planned=m.execute(args)
                args.phase='export';m.execute(args)
                decoded=subprocess.run(['age','-d','-i',str(key),str(args.archive)],capture_output=True,check=True).stdout
                assert json.loads(decoded)['inventory']['repository']['id']==repo['id']
                assert any(row['state']=='PENDING' and row['body']=='Private pending draft' for row in json.loads(decoded)['inventory']['pull_reviews'])
                args.phase='import';staged=m.execute(args)
                assert staged['phase']=='imported' and not staged['cutoverAllowed']
                args.phase='verify';verified=m.execute(args)
                assert verified['phase']=='verified-staging' and not verified['cutoverAllowed']
                assert verified['reconciliation']['pull_reviews']['matches'] is False
                args.phase='status';assert m.execute(args)['operation']==planned['operation']
            imported=target.request('GET',base)
            assert imported['private'] and imported['description']=='Golf migration '+planned['operation']
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            after=m.snapshot(target,name+'/fidelity')
            if isinstance(after.get('branches'),list) and len(after['branches'])==len(before['branches']) and len(after.get('issues',[]))==len(before['issues']):break
            time.sleep(.5)
        source_summary,target_summary=m.summary(before),m.summary(after)
        comparisons={kind:{'source':value,'target':target_summary.get(kind),'matches':value==target_summary.get(kind) and 'blocked' not in value} for kind,value in source_summary.items()}
        for kind in ('branches','issues','pulls','labels','milestones'):assert comparisons[kind]['matches'],kind+' fidelity mismatch'
        source_reviews=source.request('GET',base+'/pulls/'+str(pull['number'])+'/reviews')
        target_reviews=target.request('GET',base+'/pulls/'+str(pull['number'])+'/reviews')
        privacy={'sourcePending':sum(v['state']=='PENDING' for v in source_reviews),'targetPending':sum(v['state']=='PENDING' for v in target_reviews)}
        report={'scope':'Real Gitea 1.27.3 -> Forgejo 15.0.9 native import; private owned fixture',
            'stagingToolPhases':['plan','export','import','verify','status'],'encryptedExportRoundTrip':True,'comparisons':comparisons,'pendingReviews':privacy,'cutoverAllowed':False,'blockers':m.BLOCKERS}
        Path(os.environ['GOLF_MIGRATION_FIXTURE_RECEIPT']).write_text(json.dumps(report,indent=2)+'\n')
        stable=False
        for _ in range(10):
            try: stable=m.summary(m.snapshot(source,name+'/fidelity'))==source_summary
            except ValueError: stable=False
            if stable:break
            time.sleep(.5)
        assert stable,'source content changed after import'
        report['sourceUnchanged']=True
        Path(os.environ['GOLF_MIGRATION_FIXTURE_RECEIPT']).write_text(json.dumps(report,indent=2)+'\n')
        print('PASS: native private repository migration; branches, binary commit, issues, PRs, labels and milestones reconciled; pending review counts '+json.dumps(privacy))
    finally:
        for name in reversed(target_users):smoke.admin('delete','--username',name,'--purge')
        for name in reversed(source_users):source_admin('delete','--username',name,'--purge')

if __name__=='__main__':main()

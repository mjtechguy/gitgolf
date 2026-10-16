#!/usr/bin/env python3
"""Qualify ordinary writer source changes against retained Forgejo with host PostgreSQL.
No Docker resources are started, restarted or resized. Only disposable native
actors/repos are changed; production Golf handlers use an isolated test schema.
"""
import argparse,hashlib,json,os,secrets,subprocess,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
from smoke import ROOT,FORGE,command,provider,wait_for_push

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source-only',action='store_true',help='Run source delegation consumer without reviewer fixture');p.add_argument('--wiki',action='store_true',help='Qualify read-only wiki workspace instead of source/reviewer consumers');p.add_argument('--stack-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();stack=a.stack_root.resolve();os.umask(0o077)
    assert os.environ.get('GOLF_TEST_DATABASE_URL'),'Supply owned isolated host PostgreSQL';a.output.mkdir(parents=True,exist_ok=False)
    report={'passed':False,'ownedUsersPurged':False,'dockerResourcesCreated':0};users=[];actors={};repos=[];prefix='golf-writer-probe-'+secrets.token_hex(4)
    def admin(*v):return command('docker','compose','--project-directory',str(stack),'--file',str(stack/'compose.yaml'),'--env-file',str(stack/'.env'),'exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*v)  # Forgejo's upstream path
    try:
        for role in ('owner','writer'):
            name=prefix+'-'+role;admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');users.append(name)
            token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository,write:issue','--raw');actors[role]={'name':name,'token':token}
        owner,writer=actors['owner'],actors['writer'];repo=provider(owner['token'],'POST','user/repos',{'name':'private','private':True,'auto_init':True},expected=201);base='repos/'+repo['full_name'];repos.append((owner['token'],base));wait_for_push(owner['token'],repo['full_name'])
        provider(owner['token'],'PUT',base+'/collaborators/'+writer['name'],{'permission':'write'},expected=204)
        # An unrelated effective protection must not block ordinary branch edits.
        provider(owner['token'],'POST',base+'/branch_protections',{'rule_name':'other-protected/*','enable_push':False},expected=201)
        with tempfile.TemporaryDirectory(prefix='golf-native-writer-') as d:
            f=Path(d)/'fixture.json';fd=os.open(f,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as out:json.dump({'URL':FORGE,'Owner':owner['name'],'Writer':writer['name'],'OwnerToken':owner['token'],'WriterToken':writer['token'],'Branch':repo['default_branch'],'RepositoryID':repo['id'],'OwnerID':repo['owner']['id']},out)
            result=subprocess.run(['go','test','-race','./internal/server','-run','^TestWikiNativeProof$' if a.wiki else '^TestFileWriterNativeProof$' if a.source_only else '^(TestFileWriterNativeProof|TestReviewRequestNativeProof)$','-count=1','-v'],cwd=ROOT,env={**os.environ,'GOLF_FILE_WRITER_NATIVE_PROOF':str(f)},capture_output=True,text=True,timeout=180)
            # Source assertion messages are fixed and do not contain the envelope.
            safe=[]
            for line in (result.stdout+result.stderr).splitlines():
                if any(token in line for token in (owner['token'],writer['token'])):raise RuntimeError('private diagnostic withheld')
                safe.append(line)
            (a.output/'go-test.log').write_text('\n'.join(safe)+'\n');assert result.returncode==0,'Native writer proof failed; inspect private receipt'
        report.update(passed=True,nativeVersion=provider(owner['token'],'GET','version')['version'],sourceRevision=command('git','rev-parse','HEAD'),scope='Production wiki list/read handlers with actual native reader, Unicode/percent opaque segments, exact Markdown, empty-body ambiguity and revocation; no served UI or wiki writes.' if a.wiki else 'Production handlers with native writer Push permission, exact source bytes/replay, unrelated protections, protected target refusal and revocation. No served UI or atomic HEAD CAS claim.')
        files=['api/golf/v1/golf.proto','internal/server/repository_wiki.go','internal/server/repository_wiki_native_test.go','scripts/repository-file-writer-native-proof.py'] if a.wiki else ['internal/server/repository_file_mutations.go','internal/server/pull_review_requests.go','internal/server/pull_review_requests_native_test.go','internal/server/repository_file_writer_native_test.go']
        if not a.wiki:
            report.update(actualCLI=True,actualMCPProtocols=['2026-07-28','2025-11-25'],sourceGrantOriginalReplayRevocation=True)
            files += ['internal/server/machine_permissions.go','internal/server/machine_native_test.go','internal/cli/machine.go','internal/cli/writes.go','internal/cli/mcp.go']
        report['sourceHashes']={path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest() for path in files}
    finally:
        errors=[]
        for token,base in reversed(repos):
            try:provider(token,'DELETE',base,expected=204)
            except Exception:errors.append('owned native repository')
        for name in reversed(users):
            try:admin('delete','--username',name,'--purge')
            except Exception:errors.append('owned native actor')
        report['ownedUsersPurged']=not errors
        (a.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
        assert not errors,'Owned native cleanup failed'
    print('PASS: actual native wiki read workspace and owned fixture cleanup.' if a.wiki else 'PASS: ordinary contributor source changes, exact native readback/replay, branch-specific protection/refusal and revocation; owned fixtures purged.')
if __name__=='__main__':main()

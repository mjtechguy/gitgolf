#!/usr/bin/env python3
"""Qualify RS1 production source handlers with disposable supported native actors and Git.
No served UI, full64-object, Cloudflare, workflow, provider or recovery claim.
"""
import argparse, json, os, re, secrets, subprocess, sys, tempfile, time
from pathlib import Path
sys.dont_write_bytecode = True
from smoke import ROOT, FORGE, client, command, provider, ready, request, wait_for_push


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root',type=Path,default=ROOT)
    args=parser.parse_args(); stack=args.stack_root.resolve()
    assert (stack/'compose.yaml').is_file() and (stack/'.env').is_file()
    def admin(*values):
        return command('docker','compose','--project-directory',str(stack),'--file',str(stack/'compose.yaml'),'--env-file',str(stack/'.env'),'exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*values)  # Forgejo's upstream path
    ready(); assert request(client(),'GET',FORGE+'/api/v1/version')['version']=='15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
    prefix='golf-source-probe-'+secrets.token_hex(4); users=[]; repositories=[]; actors={}; pg=prefix+'-pg'; pg_started=False; stage='accounts'
    try:
        for role in ('owner','reader'):
            name=prefix+'-'+role
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false'); users.append(name)
            token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository,write:issue','--raw')
            actors[role]={'name':name,'token':token}
        owner,reader=actors['owner'],actors['reader']
        repo=provider(owner['token'],'POST','user/repos',{'name':'private','private':True,'auto_init':True},expected=201); full=repo['full_name']; route='repos/'+full; repositories.append((owner['token'],full)); wait_for_push(owner['token'],full)
        provider(owner['token'],'PUT',route+'/collaborators/'+reader['name'],{'permission':'read'},expected=204)
        stage='ordinary own Git fixture'
        with tempfile.TemporaryDirectory(prefix='golf-source-native-') as directory:
            root=Path(directory); ask=root/'askpass'; ask.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "%s" "$GOLF_FIXTURE_LOGIN";; *) printf "%s" "$GOLF_FIXTURE_TOKEN";; esac\n'); ask.chmod(0o700)
            env={**os.environ,'GIT_ASKPASS':str(ask),'GIT_TERMINAL_PROMPT':'0','GOLF_FIXTURE_LOGIN':owner['name'],'GOLF_FIXTURE_TOKEN':owner['token']}
            stage='own Git clone'; clone=root/'repo'; command('git','clone','--quiet',FORGE+'/'+full+'.git',str(clone),env=env)
            def git(*values):
                nonlocal stage
                stage='own Git '+values[0]
                return command('git',*values,env=env,cwd=clone)
            git('config','user.name','Native source fixture');git('config','user.email','source@example.invalid')
            text='Exact source bytes\t雪\n'; image='<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>'
            (clone/'src').mkdir(); (clone/'src'/'literal % 雪.txt').write_text(text);(clone/'empty.txt').write_bytes(b'');(clone/'logo.svg').write_text(image);(clone/'README.md').write_text('![Logo](logo.svg)\n')
            git('add','.');git('commit','--quiet','-m','Exact immutable source fixture'); old=git('rev-parse','HEAD')
            git('branch','release/雪');git('branch','release/雪-neighbor');git('tag','lightweight')
            (clone/'src'/'literal % 雪.txt').write_text('Newer ref source\n');(clone/'logo.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>');git('add','.');git('commit','--quiet','-m','Newer named ref fixture');new=git('rev-parse','HEAD')
            git('tag','-a','release/雪','-m','Annotated collision tag');tag=git('rev-parse','refs/tags/release/雪');git('branch',old)
            git('push','--quiet','origin','--all');git('push','--quiet','origin','--tags');wait_for_push(owner['token'],full)
            assert git('show',old+':src/literal % 雪.txt')==text.strip() and git('rev-parse','refs/tags/release/雪^{}')==new
            envelope={'URL':FORGE,'Owner':owner['name'],'Reader':reader['name'],'OwnerToken':owner['token'],'ReaderToken':reader['token'],'Commit':old,'NewCommit':new,'AnnotatedTagObject':tag,'RepositoryID':repo['id'],'Path':'src/literal % 雪.txt','Text':text,'Image':image}
            stage='isolated source metadata DB'; pg_image=command('docker','inspect','golf-postgres-1','--format','{{.Config.Image}}');command('docker','run','-d','--rm','--name',pg,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432',pg_image);pg_started=True
            deadline=time.monotonic()+30
            while subprocess.run(['docker','exec',pg,'pg_isready','-U','postgres'],capture_output=True).returncode:
                assert time.monotonic()<deadline;time.sleep(.2)
            port=command('docker','port',pg,'5432/tcp').rsplit(':',1)[1]
            payload=root/'proof.json'; fd=os.open(payload,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as stream: json.dump(envelope,stream)
            stage='actual production HTTP handlers'; testenv={**os.environ,'GOLF_SOURCE_SELECTION_NATIVE_PROOF':str(payload),'GOLF_TEST_DATABASE_URL':'postgres://postgres@127.0.0.1:'+port+'/postgres?sslmode=disable'}
            result=subprocess.run(['go','test','-race','./internal/server','-run','^TestSourceSelectionNativeProof$','-count=1'],cwd=ROOT,env=testenv,capture_output=True,text=True,timeout=180)
            if result.returncode:
                source=(ROOT/'internal/server/source_selection_native_test.go').read_text();allowed=set(re.findall(r't.Fatal\("([^\"]+)"\)',source))
                for line in (result.stdout+result.stderr).splitlines():
                    value=line.rsplit(': ',1)[-1].strip()
                    if value in allowed:print('Native source assertion: '+value,file=sys.stderr,flush=True)
            assert result.returncode==0,'Actual native source handler proof failed (private output withheld)'
            print('PASS: typed native branch/tag/default/commit selection, annotated/lightweight objects, slash-prefix and SHA-name collisions; original exact source/image bytes, literal UTF-8 paths, complete inventories, empty blob and revocation. No served/full64/atomic-ref/recovery claim.',flush=True)
    except Exception:
        print('FAIL stage: '+stage+' (private output withheld)',file=sys.stderr,flush=True)
        raise RuntimeError('Native source qualification failed; private diagnostics withheld') from None
    finally:
        errors=[]
        if pg_started:
            try: command('docker','rm','-f',pg)
            except Exception: errors.append('isolated PostgreSQL')
        for token,full in reversed(repositories):
            try:provider(token,'DELETE','repos/'+full,expected=204)
            except Exception:errors.append('native repository')
        for name in reversed(users):
            try:admin('delete','--username',name,'--purge')
            except Exception:errors.append('native actor')
        assert not errors,'Fixture cleanup failed: '+', '.join(errors)
        assert prefix not in admin('list'),'Native actor remained'
        print('All disposable native actors/repos and isolated PostgreSQL removed. Golf test schemas/sessions removed; no live Golf account created.',flush=True)

if __name__=='__main__': main()

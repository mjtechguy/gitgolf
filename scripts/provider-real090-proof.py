#!/usr/bin/env python3
"""Qualify actual GitHub identity/public selected import; no upstream writes.
Requires existing gh authentication and isolated host PostgreSQL. Does not
sample private projects or certify private migration/all-ref/history fidelity.
"""
import argparse,hashlib,json,os,secrets,subprocess,tempfile
from pathlib import Path
import smoke

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);a=p.parse_args();os.umask(0o077);a.output.mkdir(parents=True,exist_ok=False)
 assert os.environ.get('GOLF_TEST_DATABASE_URL'),'isolated test database required'
 name='golf-real-provider090-'+secrets.token_hex(4);created=False;report={'passed':False,'upstreamWrites':0,'privateMigrationQualified':False,'newDockerJobs':0,'ownedNativeActorPurged':False}
 try:
  github=smoke.command('gh','auth','token');assert len(github)>=20
  smoke.admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');created=True
  native=smoke.admin('generate-access-token','--username',name,'--token-name',name,'--scopes','write:user,write:repository','--raw')
  with tempfile.TemporaryDirectory(prefix='golf-real-provider090-') as folder:
   f=Path(folder)/'fixture.json';smoke.ROOT.mkdir(exist_ok=True);f.write_text(json.dumps({'NativeURL':smoke.GITEA,'NativeToken':native,'GitHubToken':github,'Owner':name}));f.chmod(0o600)
   r=subprocess.run(['go','test','-race','-p','1','./internal/server','-run','^TestProviderReal090GitHubPublicNative$','-count=1','-v'],env={**os.environ,'GOLF_REAL_PROVIDER090_FIXTURE':str(f)},capture_output=True,text=True,timeout=180)
   assert github not in r.stdout+r.stderr and native not in r.stdout+r.stderr,'private diagnostic withheld'
   (a.output/'native.log').write_text(r.stdout+r.stderr);assert r.returncode==0,'actual public provider proof failed'
  report.update(passed=True,actualGitHubIdentity=True,actualPublicSelectedImport=True,forcedPrivateDestination=True,exactDefaultHead=True,originalReplay=True,connectionRevocation=True,sourceRevision=smoke.command('git','rev-parse','HEAD'),sourceFiles={f:hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in ['internal/server/provider_import086.go','internal/server/provider_real090_test.go','scripts/provider-real090-proof.py']})
 finally:
  if created:smoke.admin('delete','--username',name,'--purge');report['ownedNativeActorPurged']=True
  (a.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
 print('PASS actual GitHub identity and public selected native clone; private fidelity remains separate; fixture purged')

if __name__=='__main__':main()

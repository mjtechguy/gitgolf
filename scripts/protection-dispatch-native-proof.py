#!/usr/bin/env python3
"""Qualify unknown native protection effects without new Docker resources.
Production Golf handlers use an isolated host PostgreSQL schema. The launcher
owns one ordinary native actor/repository and purges it; no model/job executes.
"""
import argparse, hashlib, json, os, secrets, subprocess, sys, tempfile
from pathlib import Path
sys.dont_write_bytecode = True
from smoke import ROOT, FORGE, command, provider

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not os.environ.get('GOLF_TEST_DATABASE_URL'):
        raise SystemExit('Supply an owned isolated host PostgreSQL database')
    os.umask(0o077);args.output.mkdir(parents=True,exist_ok=False)
    stack=args.stack_root.resolve();name='golf-policy-probe-'+secrets.token_hex(5)
    report={'passed':False,'ownedActorPurged':False,'dockerResourcesCreated':0,'protectedPublicationQualified':False};created=False
    def admin(*values):
        return command('docker','compose','--project-directory',str(stack),'--file',str(stack/'compose.yaml'),'--env-file',str(stack/'.env'),'exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*values)  # Forgejo's upstream path
    try:
        admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false','--admin=false');created=True
        token=admin('generate-access-token','--username',name,'--token-name',name,'--scopes','write:user,write:repository','--raw')
        report['nativeVersion']=provider(token,'GET','version')['version']
        report['sourceRevision']=command('git','rev-parse','HEAD')
        files=['internal/server/protection_dispatch_fence.go','internal/server/protection_dispatch_native_test.go','internal/server/repository_lifecycle.go','internal/server/rule_mutations.go','internal/server/repository_file_mutations.go','internal/server/repository_ref_mutations.go','internal/server/git_transport_credentials.go','scripts/protection-dispatch-native-proof.py']
        report['sourceSHA256']={path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest() for path in files}
        with tempfile.TemporaryDirectory(prefix='golf-owned-policy-') as folder:
            envelope=Path(folder)/'fixture.json';envelope.write_text(json.dumps({'URL':FORGE,'Username':name,'Token':token}));envelope.chmod(0o600)
            result=subprocess.run(['go','test','-race','-p','1','./internal/server','-run','^TestProtectionUnknownNativeProof$','-count=1','-v'],cwd=ROOT,env=os.environ|{'GOLF_PROTECTION_NATIVE_PROOF':str(envelope)},capture_output=True,text=True,timeout=180)
            log=result.stdout+result.stderr
            if token in log:raise RuntimeError('Private native diagnostic withheld')
            (args.output/'go-test.log').write_text(log);report['testExitCode']=result.returncode
            if result.returncode or '--- PASS: TestProtectionUnknownNativeProof' not in log or '--- SKIP:' in log:
                raise RuntimeError('Native policy uncertainty proof failed; inspect sanitized receipt')
        report.update(passed=True,scope='Actual native rule accepted once; acknowledgement replaced by500; production journal remainsunknown; independentnative effect read, replay/restart and managed-write refusal. Independent native/SSH/background ingress and complete protectedpublication remain unqualified.')
    finally:
        if created:
            admin('delete','--username',name,'--purge');report['ownedActorPurged']=True
        (args.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
    print('PASS actual native protection uncertainty fences later managed writes; original replay/restart safe; owned actor purged')

if __name__=='__main__':main()

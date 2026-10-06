#!/usr/bin/env python3
"""Qualify native identity-backed admin/console factor recovery with owned actors.
No Docker services/jobs are created or restarted; Golf state is in an isolated
host PostgreSQL test schema. Retained user accounts/settings are unchanged.
"""
import argparse, hashlib, json, os, secrets, subprocess, sys, tempfile
from pathlib import Path
sys.dont_write_bytecode=True
from smoke import ROOT, GITEA, command, provider

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--include-cli',action='store_true',help='Build owned host binary and qualify readonly inspection/console reset on test schema')
    args=parser.parse_args()
    if not os.environ.get('GOLF_TEST_DATABASE_URL'):
        raise SystemExit('Supply an owned isolated host PostgreSQL database')
    os.umask(0o077);args.output.mkdir(parents=True,exist_ok=False)
    stack=args.stack_root.resolve();prefix='golf-mfa-probe-'+secrets.token_hex(5)
    owned=[];tokens=[];report={'passed':False,'ownedUsersPurged':False,'dockerResourcesCreated':0,'servedRuntimeQualified':False}
    def admin(*values):
        return command('docker','compose','--project-directory',str(stack),'--file',str(stack/'compose.yaml'),'--env-file',str(stack/'.env'),'exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*values)
    try:
        actors=[]
        for role in ['admin','member']:
            name=prefix+'-'+role
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false','--admin=false')
            owned.append(name)
            token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','read:user','--raw')
            actors.append((name,token));tokens.append(token)
        report['ownedUsernames']=owned.copy();report['nativeVersion']=provider(tokens[0],'GET','version')['version']
        report['sourceRevision']=command('git','rev-parse','HEAD')
        files=['cmd/golf/local_auth.go','cmd/golf/local_auth_test.go','internal/server/local_auth.go','internal/server/database/queries/mfa_security.sql','api/golf/v1/golf.proto','internal/server/instance_mfa_recovery.go','internal/server/operator_mfa_recovery.go','internal/server/mfa_recovery_effect.go','internal/server/local_mfa.go','internal/server/admin_mfa_recovery_native_test.go','internal/server/database/migrations/202610050081_admin_mfa_recovery.sql','scripts/admin-mfa-native-source-proof.py']
        report['sourceFilesSHA256']={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in files}
        extra_env={}
        if args.include_cli:
            binary=(args.output/'golf').resolve()
            build=subprocess.run(['go','build','-o',str(binary),'./cmd/golf'],cwd=ROOT,capture_output=True,text=True,timeout=180)
            if build.returncode:raise RuntimeError('Operator binary build failed')
            binary.chmod(0o700);extra_env['GOLF_OPERATOR_CLI_NATIVE_PROOF']=str(binary)
            report['operatorBinarySHA256']=hashlib.sha256(binary.read_bytes()).hexdigest()
            report['actualCLISubprocess']=True
        with tempfile.TemporaryDirectory(prefix='golf-owned-admin-mfa-') as folder:
            envelope=Path(folder)/'fixture.json'
            envelope.write_text(json.dumps({'URL':GITEA,'AdminUsername':actors[0][0],'AdminToken':actors[0][1],'Username':actors[1][0],'Token':actors[1][1]}));envelope.chmod(0o600)
            result=subprocess.run(['go','test','-race','-p','1','./internal/server','-run','^TestAdminMFARecoveryNativeProof$','-count=1','-v'],cwd=ROOT,env=os.environ|{'GOLF_ADMIN_MFA_NATIVE_PROOF':str(envelope)}|extra_env,capture_output=True,text=True,timeout=180)
            log=result.stdout+result.stderr
            if any(token in log for token in tokens):
                raise RuntimeError('Private native diagnostic withheld')
            (args.output/'go-test.log').write_text(log);report['testExitCode']=result.returncode
            if result.returncode or '--- PASS: TestAdminMFARecoveryNativeProof' not in log or '--- SKIP:' in log:
                raise RuntimeError('Native recovery failed; inspect sanitized receipt')
        report.update(passed=True,scope='Production admin recovery with native ordinary actors and distinct Golf admin role, own admin factor, exact inventory/versions, target session/challenge revocation, managed PAT enrollment revocation, privileged console server effect and fresh unchanged-password/admin-role sign-in. Readonly operator inspection and console CLI subprocess are qualified only with --include-cli. No served-runtime/UI claim.')
    finally:
        failed=[]
        for name in reversed(owned):
            try:admin('delete','--username',name,'--purge')
            except Exception:failed.append(name)
        report['ownedUsersPurged']=not failed
        (args.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
        if failed:raise RuntimeError('Owned native actor cleanup failed')
    print('PASS actual native admin/console recovery handlers and owned actor cleanup; no new Docker resources')
if __name__=='__main__':main()

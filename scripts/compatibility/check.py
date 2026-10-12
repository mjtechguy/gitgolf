#!/usr/bin/env python3
"""Run named source/database conformance checks with distinct, private receipts."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs/compatibility'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--layer', choices=('source', 'database'), default='source')
    parser.add_argument('--output', type=Path, required=True, help='new owner-only receipt directory; never overwrite a failed proof')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    output.chmod(0o700)
    profile = json.loads((DATA / 'profile.json').read_bytes())
    files = ['internal/workflowpath/path.go', 'internal/server/workflows.go', 'internal/server/workflow_runs.go', 'internal/server/server.go', 'internal/server/execution_policy.go', 'internal/server/workflow_directories_test.go', 'engines/act/profile.go', 'engines/act/compatibility_test.go', 'scripts/compatibility/inventory.py', 'scripts/compatibility/check.py', 'docs/compatibility/profile.json']
    manifest = {
        'format': 'golf.compatibility.evidence.v1', 'packet': 'F0/F1/F2',
        'started_at': datetime.now(timezone.utc).isoformat(), 'layer': args.layer,
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT)),
        'source_files': {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in files},
        'schema': max(path.name.split('_')[0] for path in (ROOT / 'internal/server/database/migrations').glob('*.sql')),
        'profiles': {key: profile[key] for key in ('gitea', 'actions', 'gitlab', 'connected')},
        'fixture': profile['requests'], 'cases': [], 'passed': False,
        'native_execution': False, 'deployed': False,
        'cleanup': 'Only isolated test schemas managed by the existing database test helpers; no native source commands are admitted.',
    }

    def record():
        path = output / 'manifest.json'
        path.write_text(json.dumps(manifest, indent=2) + '\n')
        path.chmod(0o600)

    record()
    if args.layer == 'database' and not os.environ.get('GOLF_TEST_DATABASE_URL'):
        manifest['outcome'] = 'infrastructure-unavailable'
        manifest['reason'] = 'GOLF_TEST_DATABASE_URL must point to an owned isolated test database; source skips are not database evidence.'
        record()
        print(manifest['reason'], file=sys.stderr)
        return 2
    commands = [
        ('inventory.pins_and_drift', ['python3', 'scripts/compatibility/inventory.py', '--check']),
        ('inventory.generator', ['python3', '-m', 'unittest', 'discover', '-s', 'scripts/compatibility', '-p', 'test_*.py']),
        ('F1.source_selection', ['go', 'test', '-p', '1', './internal/workflowpath', './internal/server', '-run', '^(TestPathsAndDirectoryConfiguration|TestActionsWorkflowDirectorySelection|TestWorkflowDefinitionUsesSelectedDirectory|TestExecutionWorkflowPath|TestExecutionPolicyDenyDominance)$', '-count=1']),
        ('F2.unchanged_refusal_and_native_path', ['go', '-C', 'engines/act', 'test', '-p', '1', '-run', '^(TestPinnedRequestsLintRefusal|TestGiteaWorkflowPlanBinding)$', '-count=1', './...']),
    ]
    if args.layer == 'database':
        commands.append(('F1.database_authority', ['go', 'test', '-p', '1', './internal/server', '-run', '^(TestWorkflowDiscoveryPostgres|TestWorkflowPostWaitDenialPostgres|TestWorkflowRunDurableIntentPostgres|TestWorkflowRunConcurrentDispatchAndCancelPostgres|TestWorkflowRunSourceWaitRechecksPostgres|TestWorkflowPlannerFailureClassificationPostgres)$', '-count=1']))
    for identifier, command in commands:
        log_path = output / (identifier + '.log')
        with log_path.open('wb') as log:
            log_path.chmod(0o600)
            try:
                result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=600)
                code = result.returncode
                outcome = 'passed' if code == 0 else 'failed'
            except subprocess.TimeoutExpired:
                code, outcome = None, 'timeout'
        manifest['cases'].append({'id': identifier, 'command': command, 'layer': 'database' if identifier.endswith('database_authority') else 'source', 'expected': 'exit 0', 'exit_code': code, 'outcome': outcome, 'log_sha256': hashlib.sha256(log_path.read_bytes()).hexdigest()})
        record()
        print(identifier + ': ' + outcome, flush=True)
    manifest['finished_at'] = datetime.now(timezone.utc).isoformat()
    manifest['passed'] = all(case['outcome'] == 'passed' for case in manifest['cases'])
    manifest['outcome'] = 'passed' if manifest['passed'] else 'failed'
    record()
    return 0 if manifest['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

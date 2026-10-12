#!/usr/bin/env python3
"""Rebuild/check the pinned REST denominator; reviewed coverage is never generated."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs/compatibility'
METHODS = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options'}
STATES = {'unassessed', 'missing', 'source-tested', 'native-tested', 'runtime-tested', 'deployed', 'blocked-upstream'}


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON key: ' + key)
            result[key] = value
        return result
    return json.loads(path.read_bytes(), object_pairs_hook=unique)


def operations(spec):
    if spec.get('swagger') != '2.0' or not isinstance(spec.get('paths'), dict):
        raise ValueError('expected a Swagger 2.0 operation inventory')
    rows, ids = [], set()
    for path, item in sorted(spec['paths'].items()):
        if not path.startswith('/') or not isinstance(item, dict):
            raise ValueError('invalid API path')
        for method, operation in sorted(item.items()):
            if method not in METHODS:
                continue
            identifier = operation.get('operationId')
            if not isinstance(identifier, str) or not identifier or identifier in ids:
                raise ValueError('missing or duplicate operation ID: ' + str(identifier))
            ids.add(identifier)
            # Keep references to the frozen definitions. Inlining the schema
            # duplicates Swagger and loses recursive/nullable field semantics.
            rows.append({
                'id': identifier, 'method': method.upper(), 'path': path,
                'tags': operation.get('tags', []),
                'parameters': item.get('parameters', []) + operation.get('parameters', []),
                'responses': operation.get('responses', {}),
                'security': operation.get('security', spec.get('security', [])),
                'consumes': operation.get('consumes', spec.get('consumes', [])),
                'produces': operation.get('produces', spec.get('produces', [])),
                'deprecated': operation.get('deprecated', False),
            })
    if not rows:
        raise ValueError('empty operation inventory')
    return rows


def validate_annotation(row, annotation):
    if annotation.get('state') not in STATES or annotation.get('disposition') not in {'product', 'operator-only', 'outside-profile', 'blocked-upstream'}:
        raise ValueError('invalid assessment: ' + row['id'])
    if annotation.get('method') != row['method'] or annotation.get('path') != row['path']:
        raise ValueError('reviewed operation changed: ' + row['id'])
    if not annotation.get('reason'):
        raise ValueError('assessment needs a reason: ' + row['id'])
    if annotation.get('complete') and (annotation['state'] in {'unassessed', 'missing', 'blocked-upstream'} or not annotation.get('request_fields_complete') or not annotation.get('response_fields_complete')):
        raise ValueError('complete assessment requires implemented state and reviewed request/response fields: ' + row['id'])
    if annotation['state'] not in {'unassessed', 'missing', 'blocked-upstream'}:
        if not annotation.get('consumers') or not annotation.get('tests'):
            raise ValueError('tested assessment needs a consumer and runnable proof: ' + row['id'])
    for field in ('consumers', 'tests', 'native_evidence', 'runtime_evidence', 'deployed_evidence'):
        for reference in annotation.get(field, []):
            path = reference.split('#', 1)[0]
            resolved = (ROOT / path).resolve()
            if not resolved.is_relative_to(ROOT) or not resolved.is_file():
                raise ValueError('missing evidence reference: ' + reference)


def build(spec, annotations):
    rows = operations(spec)
    unknown = set(annotations) - {row['id'] for row in rows}
    if unknown:
        raise ValueError('annotations no longer in the provider denominator: ' + ', '.join(sorted(unknown)))
    for row in rows:
        annotation = annotations.get(row['id'])
        if annotation:
            validate_annotation(row, annotation)
        row['assessment'] = annotation or {
            'state': 'unassessed', 'disposition': 'product',
            'reason': 'No reviewed end-to-end field, role and consumer assessment yet; route presence is insufficient.',
            'consumers': [], 'ui': [], 'cli_mcp': [], 'native_token_scope': None,
            'unit_permission': None, 'pagination': None, 'limits': [], 'tests': [],
        }
    return rows


def verify_pins(profile):
    for pin in profile['files']:
        relative = Path(pin['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('unsafe fixture path')
        data = (DATA / relative).read_bytes()
        if len(data) != pin['bytes'] or hashlib.sha256(data).hexdigest() != pin['sha256']:
            raise ValueError('pinned bytes changed: ' + pin['path'])
    runtime = (ROOT / 'internal/runner/actions_protocol.go').read_text()
    if 'const ActionsEngineCommit = "' + profile['actions']['engine_commit'] + '"' not in runtime:
        raise ValueError('engine identity changed; review the compatibility corpus before upgrading')
    for catalog in profile['actions']['catalogs']:
        if ' = "' + catalog + '"' not in runtime:
            raise ValueError('engine catalog changed: ' + catalog)
    fixture = (DATA / profile['requests']['fixture']).read_text()
    for dependency in profile['requests']['dependencies']:
        if dependency.get('metadata'):
            reference = dependency['repository'].removeprefix('https://github.com/') + '@' + dependency['commit']
            if reference not in fixture:
                raise ValueError('action identity is not declared by the unchanged fixture: ' + reference)


def report(rows, catalogs, protocols, profile):
    states = Counter(row['assessment']['state'] for row in rows)
    complete = [row for row in rows if row['assessment'].get('complete') is True]
    return {
        'format': 'golf.compatibility.report.v1',
        'gitea_profile': 'gitea-' + profile['gitea']['version'], 'denominator': len(rows),
        'assessed': len(rows) - states['unassessed'],
        'states': {state: states[state] for state in sorted(STATES)},
        'implemented_complete': len(complete),
        'qualified_complete': sum(row['assessment']['state'] in {'native-tested', 'runtime-tested', 'deployed'} for row in complete),
        'deployed_complete': sum(row['assessment']['state'] == 'deployed' for row in complete),
        'catalogs': {name: dict(sorted(Counter(feature['state'] for feature in catalog['features']).items())) for name, catalog in sorted(catalogs.items())},
        'protocols': {kind: dict(sorted(Counter(row['state'] for row in protocols if row['kind'] == kind).items())) for kind in sorted({row['kind'] for row in protocols})},
        'full_compatibility': False,
        'installed_spec_comparison': profile['gitea']['installed_comparison'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail on pin, annotation or generated-output drift; never fetch or execute source')
    args = parser.parse_args()
    profile = read_json(DATA / 'profile.json')
    verify_pins(profile)
    spec = read_json(DATA / 'gitea-1.27.3.swagger.json')
    annotations = read_json(DATA / 'gitea-annotations.json')
    rows = build(spec, annotations)
    catalogs = {name: read_json(DATA / (name + '.json')) for name in ('actions', 'gitlab', 'connected')}
    protocols = read_json(DATA / 'protocols.json')['protocols']
    seen_protocols = set()
    for row in protocols:
        if row['id'] in seen_protocols or row['state'] not in STATES or row['kind'] not in {'git', 'registry', 'webhook'} or not row.get('reason'):
            raise ValueError('invalid protocol assessment: ' + row['id'])
        seen_protocols.add(row['id'])
    webhook_source = (DATA / 'fixtures/gitea-webhook-types.go.txt').read_text()
    events = set(re.findall(r'HookEvent[A-Za-z]+\s+HookEventType\s*=\s*"([a-z_]+)"', webhook_source))
    if {row['id'].removeprefix('webhook.') for row in protocols if row['kind'] == 'webhook'} != events:
        raise ValueError('webhook/event register differs from pinned Gitea source')
    for name, catalog in catalogs.items():
        seen = set()
        for feature in catalog['features']:
            if feature['id'] in seen or feature['state'] not in STATES or not feature.get('limitations'):
                raise ValueError('invalid catalog feature in ' + name)
            seen.add(feature['id'])
            if feature['state'] not in {'missing', 'unassessed', 'blocked-upstream'} and not feature.get('tests'):
                raise ValueError('tested feature has no proof: ' + feature['id'])
            for field in ('tests', 'native_evidence', 'runtime_evidence', 'deployment_evidence'):
                for reference in feature.get(field, []):
                    path = (ROOT / reference.split('#', 1)[0]).resolve()
                    if not path.is_relative_to(ROOT) or not path.is_file():
                        raise ValueError('missing feature proof: ' + reference)
    outputs = {
        'gitea-operations.json': {'format': 'golf.gitea.operations.v1', 'profile': profile['gitea'], 'operations': rows},
        'report.json': report(rows, catalogs, protocols, profile),
    }
    for name, value in outputs.items():
        data = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
        destination = DATA / name
        if args.check:
            if not destination.is_file() or destination.read_bytes() != data:
                raise ValueError('generated inventory drift: ' + name + '; run scripts/compatibility/inventory.py')
        else:
            destination.write_bytes(data)
    print(json.dumps(outputs['report.json'], sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print('Compatibility inventory failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)

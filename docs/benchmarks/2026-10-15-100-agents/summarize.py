#!/usr/bin/env python3
"""Summarize the 100-agent bench JSON (data/<run>-<scenario>.json) into summary.csv for charts.
Usage: python3 summarize.py   (reads data/, writes summary.csv)"""
import csv, json, pathlib

here = pathlib.Path(__file__).parent
rows = []
for path in sorted((here / 'data').glob('*.json')):
    run, _, _ = path.stem.partition('-')
    if run not in ('baseline', 'fixed', 'fixed2', 'fixed3'):
        continue
    for r in json.loads(path.read_text())['results']:
        scenario = r['scenario'] + ('/' + r['variant'] if r.get('variant') else '')
        for op, v in (r.get('ops') or {}).items():
            if op in ('setup', 'local'):
                continue
            outcomes = {k: n for k, n in v['outcomes'].items() if k != 'other' and n}
            outcomes.update(v['outcomes'].get('other', {}))
            failures = v['attempts'] - v['successes']
            lat = v.get('latencyMs') or {}
            rows.append({'run': run, 'scenario': scenario, 'agents': r['concurrency'], 'operation': op, 'attempts': v['attempts'],
                         'successes': v['successes'], 'failure_pct': round(100 * failures / v['attempts'], 1) if v['attempts'] else 0,
                         'p50_s': round((lat.get('p50') or 0) / 1000, 1), 'p95_s': round((lat.get('p95') or 0) / 1000, 1),
                         'max_s': round((lat.get('max') or 0) / 1000, 1),
                         # Server-Timing (fixed2 on): queue = waiting for admission in the Workspace; worker = the whole Worker request.
                         **{f'{part}_{q}_s': round(((v.get('serverTimingMs') or {}).get(part) or {}).get(q, 0) / 1000, 1) if (v.get('serverTimingMs') or {}).get(part) else ''
                            for part in ('queue', 'worker') for q in ('p50', 'p95')},
                         'outcomes': ' '.join(f'{k}={n}' for k, n in outcomes.items() if k != 'ok')})
with open(here / 'summary.csv', 'w', newline='') as out:
    writer = csv.DictWriter(out, fieldnames=list(rows[0]))
    writer.writeheader(); writer.writerows(rows)
print(f'{len(rows)} rows -> summary.csv')

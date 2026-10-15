#!/usr/bin/env python3
"""Summarize the scale-out bench JSON (data/<run>-<scenario>.json) into summary.csv.
Usage: python3 summarize.py   (reads data/, writes summary.csv)"""
import csv, json, pathlib

here = pathlib.Path(__file__).parent
runs = ('s1a', 's2a', 's2b', 's2c', 's2d', 's2e', 's2f', 's2g', 's2h')
rows = []
for path in sorted((here / 'data').glob('*.json'), key=lambda p: (runs.index(p.stem.split('-')[0]), p.stem)):
    run = path.stem.split('-')[0]
    for r in json.loads(path.read_text())['results']:
        scenario = r['scenario'] + ('/' + r['variant'] if r.get('variant') else '')
        for op, v in (r.get('ops') or {}).items():
            if op in ('setup', 'local'):
                continue
            outcomes = {k: n for k, n in v['outcomes'].items() if k != 'other' and n}
            outcomes.update(v['outcomes'].get('other', {}))
            lat, timing = v.get('latencyMs') or {}, v.get('serverTimingMs') or {}
            rows.append({'run': run, 'scenario': scenario, 'agents': r['concurrency'], 'operation': op, 'attempts': v['attempts'],
                         'successes': v['successes'], 'failure_pct': round(100 * (v['attempts'] - v['successes']) / v['attempts'], 1) if v['attempts'] else 0,
                         'p50_s': round((lat.get('p50') or 0) / 1000, 1), 'p95_s': round((lat.get('p95') or 0) / 1000, 1),
                         # queue = waiting for admission in the Workspace (0 for requests the stateless Worker serves).
                         'queue_p50_s': round(((timing.get('queue') or {}).get('p50') or 0) / 1000, 1),
                         'queue_p95_s': round(((timing.get('queue') or {}).get('p95') or 0) / 1000, 1),
                         'outcomes': ' '.join(f'{k}={n}' for k, n in outcomes.items() if k != 'ok')})
with open(here / 'summary.csv', 'w', newline='') as out:
    writer = csv.DictWriter(out, fieldnames=list(rows[0]))
    writer.writeheader(); writer.writerows(rows)
print(f'{len(rows)} rows -> summary.csv')

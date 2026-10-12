#!/usr/bin/env python3
"""Compare frozen provider APIs and locate current provider/state dependencies.

Matching routes are candidates for qualification, never behavioral parity proof.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
METHODS={'get','post','put','patch','delete','head','options'}

def operations(spec):
    return {(method.upper(),path):value for path,item in spec['paths'].items() for method,value in item.items() if method in METHODS}

def inventory(source,target):
    left,right=operations(source),operations(target)
    return [{'method':method,'path':path,'sourceOperation':left.get((method,path),{}).get('operationId'),
        'targetOperation':right.get((method,path),{}).get('operationId'),
        'state':'needs-behavioral-proof' if (method,path) in left and (method,path) in right else 'absent-from-target' if (method,path) in left else 'target-only'}
        for method,path in sorted(left.keys()|right.keys())]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    source=ROOT/'docs/compatibility/gitea-1.27.3.swagger.json'
    source_bytes,target_bytes=source.read_bytes(),args.target.read_bytes()
    report={'format':'golf.forgejo.inventory.v1','sourceSHA256':hashlib.sha256(source_bytes).hexdigest(),
        'targetSHA256':hashlib.sha256(target_bytes).hexdigest(),'operations':inventory(json.loads(source_bytes),json.loads(target_bytes)),
        'dependencies':[],'complete':False,'reason':'Static route inventory; native role/field/fidelity qualification remains required.'}
    pattern=re.compile(r'GiteaURL|GITEA_URL|GOLF_GITEA|forge_url|forge_user_id|\.gitea/workflows')
    for directory in ('cmd','internal','deploy','web/src'):
        for path in sorted((ROOT/directory).rglob('*')):
            if not path.is_file() or path.suffix not in {'.go','.sql','.yaml','.ts','.tsx','.sh'} or 'gen' in path.parts:continue
            lines=[number for number,line in enumerate(path.read_text().splitlines(),1) if pattern.search(line)]
            if lines: report['dependencies'].append({'file':str(path.relative_to(ROOT)),'lines':lines})
    report['counts']={state:sum(row['state']==state for row in report['operations']) for state in ('needs-behavioral-proof','absent-from-target','target-only')}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report['counts']))

if __name__=='__main__':main()

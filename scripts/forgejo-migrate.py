#!/usr/bin/env python3
"""Stage a selected repository through supported Gitea -> Forgejo migration APIs.

This tool never cuts traffic over or rewrites Golf identities. Unqualified data
classes remain blockers in every report. Tokens come only from the environment.
The journal and encrypted inventory archive are operator-owned private files.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

LIMIT=16<<20
REPOSITORY_FIELDS=('default_branch','private','archived','empty','updated_at','description','website')
NAME=re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$')
BLOCKERS=[
    'Golf identity/current-state mapping and credential reenrollment are not qualified.',
    'Users, organizations, teams and effective native protection require separate reconciliation.',
    'Git hidden refs, retained PR commits, LFS payloads, wiki and submodules require byte-level verification.',
    'Review authorship/dates/privacy, projects, attachments, packages and historical runs require fidelity qualification.',
    'Coordinated recovery, all-writer freeze and post-write rollback require installation-specific evidence.',
]


def require(value,message):
    if not value:raise ValueError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def origin(value):
    url=urllib.parse.urlsplit(value)
    require(url.scheme in ('https','http') and url.hostname and not url.username and not url.password and not url.query and not url.fragment and url.path in ('','/'),'Expected a credential-free HTTP(S) origin')
    require(url.scheme=='https' or url.hostname in ('localhost','127.0.0.1','::1'),'HTTP is limited to loopback; use HTTPS for remote migrations')
    return value.rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None


class API:
    def __init__(self,url,token):
        self.url=origin(url)
        require(8<=len(token)<=512 and not any(c.isspace() for c in token),'Supply the corresponding source/target token environment variable')
        self.token=token
        self.client=urllib.request.build_opener(NoRedirect)

    def request(self,method,path,payload=None,allow_missing=False):
        require(path.startswith('/') and not path.startswith('//'),'Invalid API path')
        body=None if payload is None else json.dumps(payload).encode()
        req=urllib.request.Request(self.url+'/api/v1'+path,data=body,method=method,
            headers={'Authorization':'token '+self.token,'Accept':'application/json','Content-Type':'application/json'})
        try:
            with self.client.open(req,timeout=120 if method=='POST' else 15) as response:
                data=response.read(LIMIT+1)
                require(len(data)<=LIMIT,'Provider response exceeds inventory limit')
                return json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            if error.code==404 and allow_missing:return None
            raise ValueError('Provider request failed with HTTP '+str(error.code)) from None
        except (urllib.error.URLError,TimeoutError):
            raise ValueError('Provider request outcome unavailable; inspect the journal before retrying') from None

    def pages(self,path):
        rows=[];seen=set()
        for page in range(1,1001):
            part=self.request('GET',path+('&' if '?' in path else '?')+f'limit=50&page={page}')
            require(isinstance(part,list) and len(part)<=50,'Invalid provider page')
            if not part:return rows
            marker=digest(part)
            require(marker not in seen,'Repeated provider page; inventory is incomplete')
            seen.add(marker);rows.extend(part)
            require(len(json.dumps(rows))<=LIMIT,'Inventory exceeds bound; split this migration')
        raise ValueError('Pagination limit reached; inventory is incomplete')


def snapshot(api,repository):
    base='/repos/'+repository
    repo=api.request('GET',base)
    require(repo['full_name']==repository and isinstance(repo['id'],int) and repo['id']>0,'Repository identity mismatch')
    result={'repository':repo}
    for name,path in {'branches':'/branches','tags':'/tags','refs':'/git/refs','issues':'/issues?state=all&type=issues','pulls':'/pulls?state=all',
        'labels':'/labels','milestones':'/milestones?state=all','releases':'/releases','collaborators':'/collaborators',
        'branch_protections':'/branch_protections','tag_protections':'/tag_protections','hooks':'/hooks','deploy_keys':'/keys'}.items():
        try:result[name]=api.pages(base+path)
        except ValueError:result[name]={'blocked':'Inventory endpoint unavailable or incomplete; no absence inferred'}
    # Pending reviews are visible only under the exporting actor's authority.
    # Preserve that visibility boundary; never call this a complete user export.
    for field in ('issue_comments','pull_reviews','review_comments'):result[field]=[]
    for kind in ('issues','pulls'):
        if not isinstance(result[kind],list):continue
        for item in result[kind]:
            number=item['number']
            try:
                comments=api.pages(base+'/issues/'+str(number)+'/comments')
                result['issue_comments'].extend({'number':number,**row} for row in comments)
                if kind=='pulls':
                    reviews=api.pages(base+'/pulls/'+str(number)+'/reviews')
                    result['pull_reviews'].extend({'number':number,**row} for row in reviews)
                    for review in reviews:
                        inline=api.pages(base+'/pulls/'+str(number)+'/reviews/'+str(review['id'])+'/comments')
                        result['review_comments'].extend({'number':number,'review_id':review['id'],**row} for row in inline)
            except ValueError:
                result['discussion_inventory_error']={'blocked':'Discussion/review inventory incomplete under the exporting actor'}
            require(len(json.dumps(result))<=LIMIT,'Discussion inventory exceeds bound')
    # This is a bounded inventory, never a claim that a moving source is frozen.
    again=api.request('GET',base)
    for field in ('id','updated_at','default_branch','private','archived','empty'):
        require(repo.get(field)==again.get(field),'Source changed during inventory; repeat after freezing writers')
    require(len(json.dumps(result))<=LIMIT,'Combined inventory exceeds bound')
    return result


def summary(value):
    fields=('number','title','body','state','created_at','closed_at')
    result={}
    for kind,rows in value.items():
        if kind=='repository':continue
        if not isinstance(rows,list):result[kind]=rows;continue
        if kind=='branches':projected=[{'name':r['name'],'sha':r['commit']['id']} for r in rows]
        elif kind=='tags':projected=[{'name':r['name'],'sha':r['commit']['sha']} for r in rows]
        elif kind in ('issues','pulls'):projected=[{key:r.get(key) for key in fields} for r in rows]
        elif kind=='labels':projected=[{key:r.get(key) for key in ('name','color','description')} for r in rows]
        elif kind=='milestones':projected=[{key:r.get(key) for key in ('title','description','state','due_on')} for r in rows]
        elif kind=='releases':projected=[{key:r.get(key) for key in ('tag_name','name','body','draft','prerelease')} for r in rows]
        else:projected=rows
        projected=sorted(projected,key=lambda v:json.dumps(v,sort_keys=True))
        result[kind]={'count':len(rows),'sha256':digest(projected)}
    return result


def private_file(path):
    info=path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)&0o077==0,'Journal/key must be an owner-only regular file')


def save(path,value):
    require(path.parent.is_dir(),'Journal parent must exist')
    fd,name=tempfile.mkstemp(prefix='.forgejo-journal-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as file:
            json.dump(value,file,indent=2);file.write('\n');file.flush();os.fsync(file.fileno())
        os.replace(name,path)
        fd=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if os.path.exists(name):os.unlink(name)


def execute(args):
    if args.phase=='plan':
        require(not args.journal.exists(),'Journal exists; resume its original operation')
        require(args.source and args.target and args.repository and args.owner,'plan requires source, target, repository and destination owner')
        parts=args.repository.split('/')
        require(len(parts)==2 and all(NAME.fullmatch(p) and '..' not in p for p in parts) and NAME.fullmatch(args.owner),'Invalid literal repository/owner')
        source=API(args.source,os.environ.get('GOLF_MIGRATION_SOURCE_TOKEN',''))
        target=API(args.target,os.environ.get('GOLF_MIGRATION_TARGET_TOKEN',''))
        require(source.url!=target.url,'Source and destination must be separate installations')
        require(source.request('GET','/version')['version']=='1.27.3','Source must match the qualified Gitea version')
        require(target.request('GET','/version')['version']=='15.0.9+gitea-1.22.0','Target must match the qualified Forgejo version')
        owner=target.request('GET','/users/'+args.owner)
        require(owner['login']==args.owner and owner['id']>0,'Destination owner identity mismatch')
        destination=args.owner+'/'+parts[1]
        require(target.request('GET','/repos/'+destination,allow_missing=True) is None,'Destination repository already exists')
        source_state=snapshot(source,args.repository)
        value={'format':'golf.forgejo.transfer.v1','operation':str(uuid.uuid4()),'phase':'planned',
            'source':source.url,'target':target.url,'repository':args.repository,'destination':destination,'ownerID':owner['id'],
            'sourceID':source_state['repository']['id'],'sourceSummary':summary(source_state),
            'sourceRepository':{k:source_state['repository'].get(k) for k in REPOSITORY_FIELDS},
            'blockers':BLOCKERS,'cutoverAllowed':False}
        save(args.journal,value)
    else:
        private_file(args.journal)
        value=json.loads(args.journal.read_bytes())
        require(value.get('format')=='golf.forgejo.transfer.v1' and value.get('cutoverAllowed') is False,'Invalid transfer journal')
        if args.phase=='status':return value
        source=API(value['source'],os.environ.get('GOLF_MIGRATION_SOURCE_TOKEN',''))
        target=API(value['target'],os.environ.get('GOLF_MIGRATION_TARGET_TOKEN',''))
        require(source.request('GET','/version')['version']=='1.27.3' and target.request('GET','/version')['version']=='15.0.9+gitea-1.22.0','Pinned source/target version changed')
        current=snapshot(source,value['repository'])
        require(current['repository']['id']==value['sourceID'] and summary(current)==value['sourceSummary'],'Source identity/inventory changed; create a new plan after freezing writers')
        require({k:current['repository'].get(k) for k in REPOSITORY_FIELDS}==value['sourceRepository'],'Source repository properties changed; create a new plan after freezing writers')
        if args.phase=='export':
            require(args.archive and args.recipient and not args.archive.exists(),'export requires a new archive path and age recipient')
            data=json.dumps({'journal':value,'inventory':current},sort_keys=True).encode()
            require(len(data)<=LIMIT,'Export exceeds bound')
            fd=os.open(args.archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as file:
                result=subprocess.run(['age','-r',args.recipient],input=data,stdout=file,stderr=subprocess.PIPE,timeout=60)
                file.flush();os.fsync(file.fileno())
            if result.returncode:
                args.archive.unlink();raise ValueError('age encryption failed')
            value['encryptedInventorySHA256']=hashlib.sha256(args.archive.read_bytes()).hexdigest()
            save(args.journal,value)
        elif args.phase=='import':
            require(args.source_frozen and args.target_quarantined,'Staging requires source-frozen and target-quarantined attestations')
            require(value.get('encryptedInventorySHA256'),'Export the encrypted inventory before dispatch')
            if value['phase']=='planned':
                require(target.request('GET','/repos/'+value['destination'],allow_missing=True) is None,'Destination name was occupied after planning')
                owner=target.request('GET','/users/'+value['destination'].split('/')[0])
                require(owner['id']==value['ownerID'],'Destination owner changed')
                value['phase']='dispatching';save(args.journal,value)
                # The unique marker allows response-loss reconciliation without
                # adopting an unrelated repository with the same name.
                repo=target.request('POST','/repos/migrate',{'clone_addr':value['source']+'/'+value['repository'],
                    'auth_token':source.token,'repo_owner':owner['login'],'repo_name':value['destination'].split('/')[1],
                    'service':'gitea','private':True,'mirror':False,'description':'Golf migration '+value['operation'],
                    'issues':True,'labels':True,'milestones':True,'pull_requests':True,'releases':True,'wiki':True,'lfs':True})
            else:
                require(value['phase'] in ('dispatching','imported','verified-staging'),'Invalid import state')
                repo=target.request('GET','/repos/'+value['destination'],allow_missing=True)
                require(repo is not None,'Dispatch outcome unknown; do not retry creation automatically')
            require(repo['full_name']==value['destination'] and repo['owner']['id']==value['ownerID'] and repo['private'] and repo['description']=='Golf migration '+value['operation'],'Destination identity/quarantine marker mismatch')
            if 'targetID' in value:require(repo['id']==value['targetID'],'Destination repository was replaced')
            value['targetID']=repo['id'];value['phase']='imported';save(args.journal,value)
        elif args.phase=='verify':
            require(value['phase'] in ('imported','verified-staging'),'Import must complete before verification')
            destination=snapshot(target,value['destination'])
            repo=destination['repository']
            require(repo['id']==value['targetID'] and repo['owner']['id']==value['ownerID'] and repo['private'],'Destination identity or quarantine changed')
            actual=summary(destination)
            value['reconciliation']={kind:{'source':expected,'target':actual.get(kind),'matches':expected==actual.get(kind) and 'blocked' not in expected} for kind,expected in value['sourceSummary'].items()}
            value['phase']='verified-staging';save(args.journal,value)
    return value


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase',choices=('plan','export','import','verify','status'))
    parser.add_argument('--journal',type=Path,required=True)
    for name in ('source','target','repository','owner','recipient'):parser.add_argument('--'+name)
    parser.add_argument('--archive',type=Path)
    parser.add_argument('--source-frozen',action='store_true')
    parser.add_argument('--target-quarantined',action='store_true')
    args=parser.parse_args()
    # Separate stable inode protects atomic journal replacements against two importers.
    lock=args.journal.with_suffix(args.journal.suffix+'.lock')
    fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        private_file(lock);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        value=execute(args)
        print(json.dumps({'operation':value['operation'],'phase':value['phase'],'cutoverAllowed':False,'blockers':value['blockers'],
            'mismatches':[name for name,row in value.get('reconciliation',{}).items() if not row['matches']]},indent=2))
        return 3 if args.phase=='verify' and not value['cutoverAllowed'] else 0
    finally:os.close(fd)


if __name__=='__main__':raise SystemExit(main())

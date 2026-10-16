#!/usr/bin/env python3
"""Offline CNPG chart contracts: Helm + stdlib, no cluster/secrets."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile

CHART=Path(__file__).resolve().parent
BASE={'storage':{'storageClass':'explicit-csi'},'golfAuthSecret':'existing-golf-auth','forgejoAuthSecret':'existing-forgejo-auth',
      'backup':{'existingSecret':'existing-s3-auth','destinationPath':'s3://golf-backups/production/golf/','endpointURL':'https://s3.example.invalid'}}

def merge(a,b):
    result=copy.deepcopy(a)
    for key,value in b.items():result[key]=merge(result.get(key,{}),value) if isinstance(value,dict) else value
    return result

def render(values,expected=True):
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as file:
        json.dump(values,file);file.flush()
        result=subprocess.run(['helm','template','proof',str(CHART),'-f',file.name],text=True,capture_output=True)
    assert (result.returncode==0)==expected,'Unexpected chart validation result'
    return result.stdout

output=render(BASE)
for required in ['kind: Cluster','kind: Database','kind: ObjectStore','kind: ScheduledBackup','enableSuperuserAccess: false','dataDurability: required','number: 1','podAntiAffinityType: required','databaseReclaimPolicy: retain','method: plugin','isWALArchiver: true','connectionLimit: 60','passwordSecret:','@sha256:']:
    assert required in output,required
assert 'kind: Secret' not in output and 'barmanObjectStore:' not in output and 'superuser: true' not in output
assert 'host all golf all reject' in output and 'host all forgejo all reject' in output
for invalid in [{'storage':{'storageClass':''}},{'golfAuthSecret':''},{'forgejoAuthSecret':'existing-golf-auth'},{'instances':1},{'backup':{'enabled':'false'}},{'instance':3},
                {'backup':{'existingSecret':''}},{'backup':{'destinationPath':'https://bucket/'}},{'backup':{'destinationPath':'s3://bucket/'}},{'backup':{'endpointURL':'http://store:9000'}},
                {'backup':{'endpointURL':'https://user:password@store.invalid'}},{'backup':{'retentionPolicy':'0d'}},{'imageName':'postgres:latest'},
                {'recovery':{'enabled':True,'sourceObjectStore':'source','sourceServerName':'golf-db'}}]:render(merge(BASE,invalid),False)
ca=render(merge(BASE,{'backup':{'endpointCASecret':'existing-s3-ca'}}))
assert 'endpointCA: {name: "existing-s3-ca", key: "ca.crt"}' in ca
restored=render(merge(BASE,{'clusterName':'golf-db-restored','recovery':{'enabled':True,'sourceObjectStore':'original-backups','sourceServerName':'golf-db','targetTime':'2026-10-02T00:00:00Z'}}))
assert 'recovery:' in restored and 'externalClusters:' in restored and 'targetTime:' in restored and 'initdb:' not in restored
without_backup=render(merge(BASE,{'backup':{'enabled':False}}))
assert 'kind: ObjectStore' not in without_backup and 'plugins:' not in without_backup
print('PASS: CNPG/Barman rendered contracts, explicit credentials/storage, retained database, required synchronous replication, narrow roles, fresh recovery and invalid configuration refusal')

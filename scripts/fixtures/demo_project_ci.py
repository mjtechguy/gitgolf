"""Reviewed demo CI: build the actual upstream package offline and exercise its wheel."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

SMOKE = {
    'requests': ('requests', "from requests import Request, Session\np=Session().prepare_request(Request('GET','https://example.com',params={'demo':'golf'}))\nassert p.url=='https://example.com/?demo=golf'\nassert p.method=='GET'"),
    'flask': ('flask', "from flask import Flask\napp=Flask(__name__)\n@app.get('/demo')\ndef demo(): return {'ok':True}\nr=app.test_client().get('/demo')\nassert r.status_code==200\nassert r.json=={'ok':True}"),
    'httpx': ('httpx', "import httpx\nwith httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'ok':True}))) as c:\n r=c.get('https://example.com/demo')\n assert r.status_code==200\n assert r.json()=={'ok':True}"),
    'starlette': ('starlette', "from starlette.applications import Starlette\nfrom starlette.routing import Route\nfrom starlette.responses import JSONResponse\nfrom starlette.testclient import TestClient\nasync def demo(request): return JSONResponse({'ok':True})\nwith TestClient(Starlette(routes=[Route('/demo',demo)])) as c:\n r=c.get('/demo')\n assert r.status_code==200\n assert r.json()=={'ok':True}"),
    'click': ('click', "import click\nfrom click.testing import CliRunner\n@click.command()\n@click.option('--name',default='Golf')\ndef hello(name): click.echo('Hello '+name)\nr=CliRunner().invoke(hello,['--name','demo'])\nassert r.exit_code==0\nassert r.output=='Hello demo\\n'"),
    'rich': ('rich', "import io\nfrom rich.console import Console\nfrom rich.table import Table\nout=io.StringIO(); t=Table('Project'); t.add_row('Golf demo')\nConsole(file=out,color_system=None).print(t)\nassert 'Project' in out.getvalue()\nassert 'Golf demo' in out.getvalue()"),
    'pytest': ('pytest', "import pytest\nfrom pathlib import Path\np=Path('test_demo.py');p.write_text('def test_arithmetic(): assert sum([2,3])==5\\ndef test_text(): assert \\\"golf\\\".upper()==\\\"GOLF\\\"\\n')\nassert pytest.main(['-q','-c','/dev/null',str(p)])==0"),
    'pydantic': ('pydantic', "from pydantic import BaseModel,ValidationError\nclass Demo(BaseModel): count:int\nassert Demo(count='3').count==3\ntry: Demo(count='invalid')\nexcept ValidationError: pass\nelse: raise AssertionError('Invalid count accepted')"),
    'attrs': ('attrs', "import attrs\n@attrs.define\nclass Demo:\n count:int=attrs.field(validator=attrs.validators.instance_of(int))\nassert Demo(3).count==3\ntry: Demo('invalid')\nexcept TypeError: pass\nelse: raise AssertionError('Invalid count accepted')"),
    'fastapi': ('fastapi', "from fastapi import FastAPI\nfrom fastapi.testclient import TestClient\napp=FastAPI()\n@app.get('/demo')\ndef demo(): return {'ok':True}\nwith TestClient(app) as c:\n r=c.get('/demo')\n assert r.status_code==200\n assert r.json()=={'ok':True}"),
    'werkzeug': ('werkzeug', "from werkzeug.test import Client\nfrom werkzeug.wrappers import Response\nc=Client(lambda e,s:Response('Golf demo')(e,s))\nassert c.get('/').text=='Golf demo'"),
    'jinja': ('jinja2', "from jinja2 import Environment\nt=Environment(autoescape=True).from_string('Hello {{ name }}')\nassert t.render(name='<Golf>')=='Hello &lt;Golf&gt;'"),
    'itsdangerous': ('itsdangerous', "from itsdangerous import URLSafeSerializer,BadSignature\ns=URLSafeSerializer('demo-test-only')\nt=s.dumps({'project':'Golf'})\nassert s.loads(t)=={'project':'Golf'}\ntry:s.loads(t+'bad')\nexcept BadSignature:pass\nelse:raise AssertionError('Tampered signature accepted')"),
    'typer': ('typer', "import typer\nfrom typer.testing import CliRunner\napp=typer.Typer()\n@app.command()\ndef hello(name:str):print('Hello '+name)\nr=CliRunner().invoke(app,['Golf'])\nassert r.exit_code==0 and 'Hello Golf' in r.output"),
    'tenacity': ('tenacity', "from tenacity import retry,stop_after_attempt,wait_none\ncalls=[]\n@retry(stop=stop_after_attempt(3),wait=wait_none())\ndef attempt():\n calls.append(1)\n if len(calls)<3:raise ValueError('retry')\n return 'ok'\nassert attempt()=='ok' and len(calls)==3"),
    'structlog': ('structlog', "import json,structlog\nfrom structlog.testing import ReturnLoggerFactory\nstructlog.configure(processors=[structlog.processors.JSONRenderer()],logger_factory=ReturnLoggerFactory())\nresult=json.loads(structlog.get_logger().bind(project='Golf').info('built',count=3))\nassert result=={'project':'Golf','count':3,'event':'built'}"),
}


def run(argv, **kwargs):
    result = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=40, check=False, **kwargs)
    print(result.stdout[-12000:])
    if result.returncode:
        raise RuntimeError('Demo CI command failed: ' + argv[0])
    return result.stdout


def main():
    root = Path.cwd()
    selected = json.loads((root/'.golf/demo-project.json').read_text())
    module, script = SMOKE[selected['name']]
    dist = root/'dist'; dist.mkdir(exist_ok=True)
    head = subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip()
    assert head == os.environ.get('GOLF_COMMIT', head)
    run([sys.executable,'-m','pip','wheel','--no-build-isolation','--no-deps','--no-cache-dir','--wheel-dir',str(dist),'.'])
    wheels = list(dist.glob('*.whl')); assert len(wheels)==1
    with tempfile.TemporaryDirectory(prefix='golf-built-wheel-') as directory:
        installed = Path(directory)/'installed'
        dependencies=sorted((root/'.golf/dependencies').glob('*.whl'))
        run([sys.executable,'-m','pip','install','--no-deps','--no-index','--target',str(installed),str(wheels[0]),*[str(p) for p in dependencies]])
        # Import from the built wheel, never silently fall back to the preinstalled package.
        checked = "from pathlib import Path\nimport " + module + "\nassert Path(" + module + ".__file__).resolve().is_relative_to(Path(" + repr(str(installed)) + "))\n" + script
        run([sys.executable,'-c',checked], cwd=directory, env={**os.environ,'PYTHONPATH':str(installed),'PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1'})
    archive = subprocess.check_output(['git','archive','--format=tar','HEAD'])
    assert len(archive)<=64*1024*1024
    compressed=gzip.compress(archive, mtime=0)
    assert len(compressed)<=24*1024*1024
    (dist/'source.tar.gz').write_bytes(compressed)
    report = {'schema':'golf.demo.package-ci.v1','project':selected['name'],'upstream':selected['upstream'],
              'upstreamCommit':selected['commit'],'commit':head,'state':'PASSED','checks':['offline wheel build','functional smoke against built wheel'],
              'artifacts':[{'name':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in sorted(dist.iterdir()) if p.is_file()]}
    (dist/'ci-report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))
    runpy.run_path(str(root/'.golf/registry_publish.py'))['publish']()


if __name__=='__main__':
    main()

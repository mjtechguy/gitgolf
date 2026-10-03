#!/usr/bin/env python3
"""Load a pinned local Codex task image into the existing dedicated daemon."""
import os,pathlib,re,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1]
image=subprocess.check_output(['docker','image','inspect','golf-codex-task:0.160.0','--format','{{.Id}}'],text=True).strip()
if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise SystemExit('Build Dockerfile.codex first')
# No environment, credentials or repository data is serialized into this image.
save=subprocess.Popen(['docker','image','save',image],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
load=subprocess.run(['docker','exec','-i','golf-runner-1','docker','image','load'],stdin=save.stdout,capture_output=True,timeout=120)
save.stdout.close();saved=save.wait(timeout=10)
if saved or load.returncode:raise SystemExit('Loading the approved image into the dedicated worker daemon failed')
file=root/'.env.agents'
if file.exists() and file.read_text()!=f'GOLF_AGENT_IMAGE={image}\n':raise SystemExit('Existing agent image differs; inspect before explicit replacement')
if file.is_symlink():raise SystemExit('Refusing a linked agent configuration')
fd=os.open(file,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
os.fchmod(fd,0o600)
with os.fdopen(fd,'w') as out:out.write(f'GOLF_AGENT_IMAGE={image}\n')
print('Pinned native task image loaded; private agent configuration written')

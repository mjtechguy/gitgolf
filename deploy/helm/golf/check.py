#!/usr/bin/env python3
"""Offline chart contract checks; stdlib + Helm, no cluster or credentials."""
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

CHART = Path(__file__).resolve().parent
HELM = os.environ.get("HELM") or shutil.which("helm")
if not HELM:
    raise SystemExit("Helm is required; set HELM=/path/to/helm")
BASE = {
    "image": {"repository": "golf-local", "tag": "chart-render-fixture"},
    "publicURL": "https://golf.example.invalid",
    "forge": {"instanceID": "ba09ae45-092f-4b4d-9e17-c6b848e5d95c"},
    "forgejo": {"publicURL": "https://git.example.invalid"},
    "existingSecret": "existing-golf-secret",
}


def merge(base, update):
    result = copy.deepcopy(base)
    for key, value in update.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = value
    return result


def render(values, expected=True, lint=False):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as file:
        json.dump(values, file)
        file.flush()
        args = [HELM, "lint", str(CHART), "--strict"] if lint else [HELM, "template", "check", str(CHART)]
        proc = subprocess.run(args + ["-f", file.name], capture_output=True, text=True, check=False)
    if (proc.returncode == 0) != expected:
        raise AssertionError("unexpected Helm validation result:\n" + proc.stderr + proc.stdout)
    return proc.stdout


def documents(manifest):
    return [part for part in re.split(r"^---\s*$", manifest, flags=re.M) if re.search(r"^kind:", part, re.M)]


def find(manifest, kind, name):
    matches = [part for part in documents(manifest) if f"kind: {kind}\n" in part and f"\n  name: {name}\n" in part]
    assert len(matches) == 1, f"expected one {kind}/{name}"
    return matches[0]


assert (CHART / "files/postgres-init.sh").read_bytes() == (CHART.parents[1] / "postgres/forgejo-init.sh").read_bytes(), "PostgreSQL init script drift"
render(BASE, lint=True)
core = render(BASE)
assert "kind: Secret\n" not in core, "chart must only reference precreated Secrets"
golf = find(core, "Deployment", "check-golf")
assert 'name: GOLF_FORGE_WORKFLOW_DIRS' in golf
assert 'name: FORGEJO__actions__WORKFLOW_DIRS, value: ".forgejo/workflows,.github/workflows"' in find(core, "StatefulSet", "check-golf-forgejo")
reversed_dirs = render(merge(BASE, {"forgejo": {"workflowDirs": ".github/workflows,.forgejo/workflows"}}))
assert reversed_dirs.count('value: ".github/workflows,.forgejo/workflows"') == 2
render(merge(BASE, {"forgejo": {"workflowDirs": "custom/workflows"}}), expected=False)
for key in ["GOLF_ENCRYPTION_KEY", "GOLF_ENCRYPTION_KEYS", "GOLF_ACTIVE_ENCRYPTION_KEY"]:
    assert re.search(r"key: " + key + r", optional: true", golf), "keyring settings must reference optional existing Secret keys"
assert re.search(r"key: DATABASE_URL\}", golf), "database credential must remain required"

for component in ("forgejo", "postgres"):
    stateful = find(core, "StatefulSet", f"check-golf-{component}")
    assert re.search(r"^  replicas: 1$", stateful, re.M), "canonical writer count changed"
    assert "whenDeleted: Retain, whenScaled: Retain" in stateful
    assert "accessModes: [ReadWriteOnce]" in stateful
    assert "automountServiceAccountToken: false" in stateful
    assert "readOnlyRootFilesystem: true" in stateful
    assert "runAsNonRoot: true" in stateful
assert 'name: FORGEJO__server__PUBLIC_URL_DETECTION, value: "never"' in find(core, "StatefulSet", "check-golf-forgejo"), "native clone URLs must use the configured public origin"
assert core.count("annotations: {helm.sh/resource-policy: keep}") == 3, "expected three retained PVC templates"
assert "ingress: []" in find(core, "NetworkPolicy", "check-golf"), "default public ingress must be denied"
assert "egress: []" in find(core, "NetworkPolicy", "check-golf-postgres"), "PostgreSQL egress must be denied"
assert "GOLF_FORGE_OAUTH_CLIENT_SECRET" not in core, "disabled OAuth must not require OAuth secrets"
assert "key: GOLF_FORGE_OAUTH_CLIENT_SECRET" in render(merge(BASE, {"oauth": {"enabled": True}}))
assert "replicas: 2" in find(render(merge(BASE, {"replicaCount": 2})), "Deployment", "check-golf")
render(merge(BASE, {"publicURL": "http://localhost:8086", "allowInsecureCookies": True, "forgejo": {"publicURL": "http://localhost:3006"}}))
render(merge(BASE, {"image": {"tag": "", "digest": "sha256:" + "a" * 64}}))
peer = {"podSelector": {"matchLabels": {"app.kubernetes.io/instance": "canonical"}}}
external = merge(BASE, {
    "forgejo": {"enabled": False, "externalURL": "http://canonical-golf-forgejo:3000"},
    "postgresql": {"enabled": False},
    "networkPolicy": {"externalEgress": [{"to": [peer], "ports": [{"protocol": "TCP", "port": 3000}, {"protocol": "TCP", "port": 5432}]}]},
})
manifest = render(external)
assert "kind: StatefulSet\n" not in manifest and "volumeClaimTemplates:" not in manifest
assert "POSTGRES_PASSWORD" not in manifest and "FORGEJO_DB_PASSWORD" not in manifest
assert len(documents(manifest)) == 3, "external profile should create only Golf service/deployment/policy"
render(merge(BASE, {"postgresql": {"enabled": False}, "forgejo": {"database": {"host": "database.example.invalid:5432"}}, "networkPolicy": {"externalEgress": [{"to": [{"ipBlock": {"cidr": "10.10.0.0/24"}}], "ports": [{"port": 5432}]}]}}))
controller = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ingress-nginx"}}}
ingress = merge(BASE, {"ingress": {"enabled": True, "className": "nginx", "tlsSecret": "existing-golf-tls"}, "networkPolicy": {"ingressFrom": [controller]}})
assert "kind: Ingress\n" in render(ingress)
metrics = render(merge(BASE, {"observability": {"metrics": {"enabled": True, "ingressFrom": [peer]}}}))
assert "key: GOLF_METRICS_TOKEN" in find(metrics, "Deployment", "check-golf")
assert "port: 9090" in find(metrics, "Service", "check-golf")
assert "port: 9090" in find(metrics, "NetworkPolicy", "check-golf")
assert "GOLF_METRICS_TOKEN" not in core
assert "port: 9090" not in find(core, "Service", "check-golf")
assert 'name: check-golf-webhooks\n' not in core, 'default profile must not launch delivery consumer'
hooks = render(merge(BASE, {'webhooks': {'enabled': True}}))
worker = find(hooks, 'Deployment', 'check-golf-webhooks')
for value in ('replicas: 1', 'strategy: {type: Recreate}', 'args: [webhook-worker]', 'automountServiceAccountToken: false', 'readOnlyRootFilesystem: true', 'runAsNonRoot: true'):
    assert value in worker, 'optional delivery worker isolation contract changed'
assert 'docker.sock' not in worker and 'hostPath:' not in worker and 'containerPort:' not in worker
assert 'key: GOLF_WEBHOOK_EGRESS_POLICY, optional: true' in worker
assert 'key: GOLF_WEBHOOK_EGRESS_POLICY, optional: true' in find(hooks, 'Deployment', 'check-golf')
policy = find(hooks, 'NetworkPolicy', 'check-golf-webhooks')
assert 'ingress: []' in policy and 'app.kubernetes.io/component: forgejo' in policy and 'app.kubernetes.io/component: postgres' in policy
assert 'port: 443' not in policy, 'destination traffic must remain denied without explicit approved rules'
for name in ('check-golf-forgejo', 'check-golf-postgres'):
    assert 'app.kubernetes.io/component: webhooks' in find(hooks, 'NetworkPolicy', name), 'worker needs only explicit native/database ingress'
receiver = {'to': [{'ipBlock': {'cidr': '203.0.113.10/32'}}], 'ports': [{'protocol': 'TCP', 'port': 443}]}
approved = render(merge(BASE, {'webhooks': {'enabled': True, 'httpsEgress': [receiver]}}))
assert 'cidr: 203.0.113.10/32' in find(approved, 'NetworkPolicy', 'check-golf-webhooks')
assert 'cidr: 203.0.113.10/32' not in find(approved, 'NetworkPolicy', 'check-golf'), 'receiver rules must not broaden application egress'
# Documentation-range address is a render fixture, never a successful receiver.
assert 'kind: NetworkPolicy\n' not in render(merge(BASE, {'webhooks': {'enabled': True}, 'networkPolicy': {'enabled': False}}))
render(merge(BASE, {"observability": {"tracing": {"endpoint": "http://collector:4318", "insecure": True}}, "networkPolicy": {"externalEgress": [{"to": [peer], "ports": [{"port": 4318}]}]}}))
negative = [
    merge(BASE, {"observability": {"tracing": {"sampleRatio": 1.1}}}),
    merge(BASE, {"observability": {"tracing": {"endpoint": "http://collector:4318"}}}),
    merge(BASE, {"observability": {"tracing": {"endpoint": "https://user:secret@collector"}}}),
    merge(BASE, {"observability": {"tracing": {"endpoint": "https://collector"}}}),
    {},
    merge(BASE, {"existingSecret": ""}),
    merge(BASE, {"publicURL": ""}),
    merge(BASE, {"image": {"tag": ""}}),
    merge(BASE, {"image": {"tag": "latest"}}),
    merge(BASE, {"image": {"repository": "golf-local:other"}}),
    merge(BASE, {"image": {"digest": "sha256:" + "a" * 64}}),
    merge(BASE, {"forgejo": {"replicaCount": 2}}),
    merge(BASE, {"forgejo": {"qualifiedVersion": "1.26.0"}}),
    merge(BASE, {"forgejo": {"image": {"tag": "1.27.3"}}}),
    merge(BASE, {"forgejo": {"database": {"user": "postgres"}}}),
    merge(BASE, {"forgejo": {"enabled": False}}),
    merge(BASE, {"postgresql": {"enabled": False}}),
    merge(external, {"networkPolicy": {"externalEgress": []}}),
    merge(BASE, {"publicURL": "http://golf.example.invalid", "allowInsecureCookies": True}),
    merge(BASE, {"publicURL": "https://user:password@golf.example.invalid"}),
    merge(BASE, {"forgejo": {"publicURL": "https://git.example.invalid/path"}}),
    merge(BASE, {"ingress": {"enabled": True}}),
    merge(ingress, {"ingress": {"tlsSecret": ""}}),
    merge(ingress, {"publicURL": "https://same.example:443", "forgejo": {"publicURL": "https://same.example:8443"}}),
    merge(BASE, {"inlinePassword": "forbidden"}),
]
for case in negative:
    render(case, expected=False)
print(f"Helm lint + bundled/external/OAuth/ingress/replica/optional-webhook profiles passed; {len(negative)} invalid configurations rejected; canonical init script matches")

fj = core
assert 'name: GOLF_FORGE_KIND, value: "forgejo"' in fj
assert 'name: FORGEJO__actions__ENABLED, value: "false"' in fj
assert 'image: "codeberg.org/forgejo/forgejo@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413"' in fj
assert 'whenDeleted: Retain' in fj
render(merge(BASE, {"forge": {"instanceID": ""}}), expected=False)
render(merge(BASE, {"forgejo": {"image": {"digest": "sha256:" + "a"*64}}}), expected=False)
print("Forgejo default rendering, exact image/identity gates and native Actions isolation passed")

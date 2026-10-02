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
    "gitea": {"publicURL": "https://git.example.invalid"},
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


assert (CHART / "files/postgres-init.sh").read_bytes() == (CHART.parents[1] / "postgres/init.sh").read_bytes(), "PostgreSQL init script drift"
render(BASE, lint=True)
core = render(BASE)
assert "kind: Secret\n" not in core, "chart must only reference precreated Secrets"
golf = find(core, "Deployment", "check-golf")
for key in ["GOLF_ENCRYPTION_KEY", "GOLF_ENCRYPTION_KEYS", "GOLF_ACTIVE_ENCRYPTION_KEY"]:
    assert re.search(r"key: " + key + r", optional: true", golf), "keyring settings must reference optional existing Secret keys"
assert re.search(r"key: DATABASE_URL\}", golf), "database credential must remain required"

for component in ("gitea", "postgres"):
    stateful = find(core, "StatefulSet", f"check-golf-{component}")
    assert re.search(r"^  replicas: 1$", stateful, re.M), "canonical writer count changed"
    assert "whenDeleted: Retain, whenScaled: Retain" in stateful
    assert "accessModes: [ReadWriteOnce]" in stateful
    assert "automountServiceAccountToken: false" in stateful
    assert "readOnlyRootFilesystem: true" in stateful
    assert "runAsNonRoot: true" in stateful
assert core.count("annotations: {helm.sh/resource-policy: keep}") == 3, "expected three retained PVC templates"
assert "ingress: []" in find(core, "NetworkPolicy", "check-golf"), "default public ingress must be denied"
assert "egress: []" in find(core, "NetworkPolicy", "check-golf-postgres"), "PostgreSQL egress must be denied"
assert "GITEA_OAUTH_CLIENT_SECRET" not in core, "disabled OAuth must not require OAuth secrets"
assert "key: GITEA_OAUTH_CLIENT_SECRET" in render(merge(BASE, {"oauth": {"enabled": True}}))
assert "replicas: 2" in find(render(merge(BASE, {"replicaCount": 2})), "Deployment", "check-golf")
render(merge(BASE, {"publicURL": "http://localhost:8086", "allowInsecureCookies": True, "gitea": {"publicURL": "http://localhost:3006"}}))
render(merge(BASE, {"image": {"tag": "", "digest": "sha256:" + "a" * 64}}))
peer = {"podSelector": {"matchLabels": {"app.kubernetes.io/instance": "canonical"}}}
external = merge(BASE, {
    "gitea": {"enabled": False, "externalURL": "http://canonical-golf-gitea:3000"},
    "postgresql": {"enabled": False},
    "networkPolicy": {"externalEgress": [{"to": [peer], "ports": [{"protocol": "TCP", "port": 3000}, {"protocol": "TCP", "port": 5432}]}]},
})
manifest = render(external)
assert "kind: StatefulSet\n" not in manifest and "volumeClaimTemplates:" not in manifest
assert "POSTGRES_PASSWORD" not in manifest and "GITEA_DB_PASSWORD" not in manifest
assert len(documents(manifest)) == 3, "external profile should create only Golf service/deployment/policy"
render(merge(BASE, {"postgresql": {"enabled": False}, "gitea": {"database": {"host": "database.example.invalid:5432"}}, "networkPolicy": {"externalEgress": [{"to": [{"ipBlock": {"cidr": "10.10.0.0/24"}}], "ports": [{"port": 5432}]}]}}))
controller = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ingress-nginx"}}}
ingress = merge(BASE, {"ingress": {"enabled": True, "className": "nginx", "tlsSecret": "existing-golf-tls"}, "networkPolicy": {"ingressFrom": [controller]}})
assert "kind: Ingress\n" in render(ingress)
negative = [
    {},
    merge(BASE, {"existingSecret": ""}),
    merge(BASE, {"publicURL": ""}),
    merge(BASE, {"image": {"tag": ""}}),
    merge(BASE, {"image": {"tag": "latest"}}),
    merge(BASE, {"image": {"repository": "golf-local:other"}}),
    merge(BASE, {"image": {"digest": "sha256:" + "a" * 64}}),
    merge(BASE, {"gitea": {"replicaCount": 2}}),
    merge(BASE, {"gitea": {"qualifiedVersion": "1.26.0"}}),
    merge(BASE, {"gitea": {"image": {"tag": "1.27.3"}}}),
    merge(BASE, {"gitea": {"database": {"user": "postgres"}}}),
    merge(BASE, {"gitea": {"enabled": False}}),
    merge(BASE, {"postgresql": {"enabled": False}}),
    merge(external, {"networkPolicy": {"externalEgress": []}}),
    merge(BASE, {"publicURL": "http://golf.example.invalid", "allowInsecureCookies": True}),
    merge(BASE, {"publicURL": "https://user:password@golf.example.invalid"}),
    merge(BASE, {"gitea": {"publicURL": "https://git.example.invalid/path"}}),
    merge(BASE, {"ingress": {"enabled": True}}),
    merge(ingress, {"ingress": {"tlsSecret": ""}}),
    merge(ingress, {"publicURL": "https://same.example:443", "gitea": {"publicURL": "https://same.example:8443"}}),
    merge(BASE, {"inlinePassword": "forbidden"}),
]
for case in negative:
    render(case, expected=False)
print(f"Helm lint + bundled/external/OAuth/ingress/replica profiles passed; {len(negative)} invalid configurations rejected; canonical init script matches")

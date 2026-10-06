#!/usr/bin/env python3
"""Existing enrolled worker only: no-model, credential-free ACP initialization."""
import argparse
import hashlib
import json
import os
import select
import subprocess
import time
import uuid
import re
from pathlib import Path


def docker(*args):
    return subprocess.check_output(["docker", *args], stderr=subprocess.DEVNULL, timeout=10)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", default="golf-agent-worker-1")
    parser.add_argument("--output", required=True)
    parser.add_argument("--managed-policy", action="store_true")
    args = parser.parse_args()
    labels = json.loads(docker("inspect", "-f", "{{json .Config.Labels}}", args.container))
    assert labels.get("com.docker.compose.project") == "golf"
    assert labels.get("com.docker.compose.service") == "agent-worker"
    image = docker("inspect", "-f", "{{.Image}}", args.container).decode().strip()
    assert image.startswith("sha256:") and len(image) == 71
    scratch = "/tmp/golf-acp088-" + uuid.uuid4().hex
    workspace = scratch + "/workspace"
    env = ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
           "HOME=" + scratch + "/home", "XDG_DATA_HOME=" + scratch + "/data",
           "XDG_CONFIG_HOME=" + scratch + "/config", "XDG_CACHE_HOME=" + scratch + "/cache",
           "OPENCODE_DISABLE_AUTOUPDATE=true", "OPENCODE_DISABLE_MODELS_FETCH=true",
           "OPENCODE_DISABLE_DEFAULT_PLUGINS=true", "OPENCODE_DISABLE_PROJECT_CONFIG=true"]
    process = None
    try:
        docker("exec", args.container, "/bin/mkdir", "-p", workspace)
        selected_model = ""
        policy_receipt = None
        if args.managed_policy:
            source = (Path(__file__).resolve().parents[1] / "internal/runner/acp_managed.go").read_text()
            policy = json.loads(re.search(r"const managedACPConfig = `([^`]+)`", source).group(1))
            docker("exec", args.container, "/bin/mkdir", "-p", scratch + "/config/opencode", scratch + "/data/opencode")
            def write_private(name, payload):
                subprocess.run(["docker", "exec", "-i", args.container, *env, "/bin/sh", "-c", "umask 077; cat > " + scratch + "/" + name], input=json.dumps(payload).encode(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            write_private("config/opencode/opencode.json", policy)
            write_private("data/opencode/auth.json", {"opencode-go": {"type": "api", "key": "invalid-golf-no-model-qualification-00000"}})
            catalog = docker("exec", "--workdir", workspace, args.container, *env, "opencode", "models", "opencode-go").decode().splitlines()
            models = [model for model in catalog if model.startswith("opencode-go/") and len(model) < 256 and not any(c.isspace() for c in model)]
            assert models, "No local native Go model catalog"
            selected_model = models[0]
            policy["model"] = selected_model
            write_private("config/opencode/opencode.json", policy)
            native_policy = json.loads(docker("exec", "--workdir", workspace, args.container, *env, "opencode", "debug", "agent", "golf-workspace"))
            policy_receipt = {"name": native_policy.get("name"), "tools": native_policy.get("tools"), "permission": native_policy.get("permission")}
            assert policy_receipt["name"] == "golf-workspace"
            assert {name for name, enabled in policy_receipt["tools"].items() if enabled} == {"read", "edit", "write"}
        version = docker("exec", "--workdir", workspace, args.container, *env, "opencode", "--version").decode().strip()
        assert len(version) < 64 and all(c.isdigit() or c in ".-" for c in version)
        process = subprocess.Popen(["docker", "exec", "-i", "--workdir", workspace, args.container,
                                    *env, "/bin/sh", "-c", "echo $$ > " + scratch + "/native.pid; exec opencode acp"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        buffered = b""
        total = 0

        def exchange(identity, method, params):
            nonlocal buffered, total
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": identity, "method": method, "params": params}).encode() + b"\n")
            process.stdin.flush()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if b"\n" not in buffered:
                    if not select.select([process.stdout], [], [], min(1, deadline - time.monotonic()))[0]:
                        continue
                    data = os.read(process.stdout.fileno(), 4096)
                    assert data, "Native transport ended"
                    total += len(data)
                    assert total <= 256 * 1024
                    buffered += data
                while b"\n" in buffered:
                    line, buffered = buffered.split(b"\n", 1)
                    frame = json.loads(line)
                    assert frame.get("jsonrpc") == "2.0"
                    if frame.get("id") == identity:
                        assert "error" not in frame
                        return frame["result"]
                    assert frame.get("method") == "session/update"
            raise AssertionError("Native initialization deadline")

        initialized = exchange(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "golf-acp088-no-model", "version": "088"}})
        assert initialized["protocolVersion"] == 1
        session = exchange(2, "session/new", {"cwd": workspace, "mcpServers": []})
        assert version == "1.18.34" and initialized.get("agentInfo", {}).get("version") == version
        if args.managed_policy:
            current = {option.get("category"): option.get("currentValue") for option in session.get("configOptions", [])}
            assert current.get("mode") == "golf-workspace" and current.get("model") == selected_model
        session_id = session["sessionId"]
        assert isinstance(session_id, str) and 0 < len(session_id) <= 128
        receipt = {"kind": "existing-worker-no-model-initialize-session", "image": image,
                   "cliVersion": version, "reportedAgentVersion": initialized.get("agentInfo", {}).get("version", ""),
                   "protocolVersion": 1, "sessionSha256": hashlib.sha256(session_id.encode()).hexdigest(),
                   "providerCredentials": "none", "prompts": 0, "newContainers": 0,
                   "managedTaskSandboxQualified": False, "inferenceQualified": False,
                   "managedExpectedVersion": "1.18.34"}
        if args.managed_policy:
            receipt.update({"providerCredentials": "synthetic-invalid-qualification-key", "selectedModel": selected_model,
                            "modeReceipt": session.get("modes", {}), "modelReceipt": session.get("models", {}),
                            "configOptions": session.get("configOptions", []), "policyReceipt": policy_receipt,
                            "configuredPolicyQualified": False})
        with open(args.output, "w", encoding="utf-8") as stream:
            json.dump(receipt, stream, indent=2)
            stream.write("\n")
        print(json.dumps(receipt))
    finally:
        if process:
            process.stdin.close()
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        # The exact own PID is only killed while its cwd still binds this probe.
        cleanup = "if test -f " + scratch + "/native.pid; then pid=$(cat " + scratch + "/native.pid); case \"$pid\" in ''|*[!0-9]*) exit 1;; esac; if test \"$(readlink /proc/$pid/cwd 2>/dev/null || true)\" = " + workspace + "; then kill -TERM \"$pid\" 2>/dev/null || true; for n in 1 2 3 4 5; do test -d /proc/$pid || break; sleep 0.1; done; if test \"$(readlink /proc/$pid/cwd 2>/dev/null || true)\" = " + workspace + "; then kill -KILL \"$pid\" 2>/dev/null || true; fi; fi; fi; rm -rf -- " + scratch
        docker("exec", args.container, "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/bin/sh", "-c", cleanup)


if __name__ == "__main__":
    main()

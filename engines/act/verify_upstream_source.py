#!/usr/bin/env python3
"""Verify the closed, pinned act runtime subset and its single source patch.

No module-cache writes, downloads, Go builds, or network requests. An optional
--upstream-dir independently checks every baseline byte against a local v0.2.89
module source. --self-check tests rejection using disposable copies only.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

HERE = Path(__file__).resolve().parent
PIN = {
    "version": "v0.2.89",
    "sourceCommitId": "4f411281417e88660bea1c1a1749aa71ae0bd60f",
    "tagObjectId": "434d69682c7a8db2ac913e5dc3e80ba68055d50d",
    "goModuleSum": "h1:d9oFeJ6jUkaVExuG+XzAaMPDqoDrNHaGeiRb8IU+N5w=",
    "goModSum": "h1:9djXFAZR+ltqh1k/8I0G2/3ypi2UrcuFlrC25L6WoCA=",
    "goModuleZipSHA256": "b4e568212d680a32076455b84ab572d17fe65eb83a6fd6dce6a05164bd68fcc9",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify(root, manifest, upstream=None):
    if manifest.get("schemaVersion") != 1 or manifest.get("upstream") != PIN:
        raise ValueError("unexpected source pin or manifest schema")
    entries = manifest["files"]
    golf_files = {".golf-upstream/expression.go.txt", ".golf-upstream/numeric-inputs.patch",
                  "pkg/runner/golf_dispatch_inputs_test.go"}
    expected = {}
    for row in entries:
        path = row["path"]
        if (not isinstance(path, str) or not path or Path(path).is_absolute()
                or any(p in ("", ".", "..") for p in path.split("/"))
                or "\\" in path or path in expected
                or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"])):
            raise ValueError("invalid or duplicate manifest path/hash")
        expected[path] = row
    actual = set()
    if root.is_symlink():
        raise ValueError("symlink runtime root")
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("symlink in runtime source")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    if actual != set(expected):
        raise ValueError("runtime file set differs from manifest")
    for path, row in expected.items():
        content = (root / path).read_bytes()
        if sha(content) != row["sha256"]:
            raise ValueError("runtime source digest mismatch: " + path)
        baseline = row.get("upstreamSha256")
        if (baseline is None) != (path in golf_files):
            raise ValueError("unexpected baseline/source classification")
        if baseline is not None:
            if not re.fullmatch(r"[a-f0-9]{64}", baseline):
                raise ValueError("invalid upstream digest")
            if path != "pkg/runner/expression.go" and baseline != row["sha256"]:
                raise ValueError("unrecorded upstream patch: " + path)
            if upstream is not None and sha((upstream / path).read_bytes()) != baseline:
                raise ValueError("independent upstream byte mismatch: " + path)
    for path in ("LICENSE", "go.mod", "go.sum", "pkg/runner/hashfiles/index.js",
                 "pkg/runner/res/trampoline.js", "pkg/schema/workflow_schema.json",
                 "pkg/schema/action_schema.json"):
        if expected[path].get("upstreamSha256") != expected[path]["sha256"]:
            raise ValueError("license/module/embed baseline changed")
    original = (root / ".golf-upstream/expression.go.txt").read_bytes()
    patched = (root / "pkg/runner/expression.go").read_bytes()
    diff = "".join(difflib.unified_diff(
        original.decode().splitlines(True), patched.decode().splitlines(True),
        fromfile="a/pkg/runner/expression.go", tofile="b/pkg/runner/expression.go")).encode()
    patch = (root / ".golf-upstream/numeric-inputs.patch").read_bytes()
    if (sha(original) != expected["pkg/runner/expression.go"]["upstreamSha256"]
            or diff != patch or sha(patch) != manifest["patchSha256"]):
        raise ValueError("baseline/patch reconstruction mismatch")
    return len(entries)


def self_check(root, manifest):
    changes = (
        lambda p: (p / "LICENSE").write_text("altered license"),
        lambda p: (p / "unexpected.go").write_text("package act\n"),
        lambda p: (p / "pkg/runner/hashfiles/index.js").unlink(),
        lambda p: (p / ".golf-upstream/expression.go.txt").write_text("wrong baseline"),
        lambda p: (p / "symlink").symlink_to(p / "LICENSE"),
    )
    for change in changes:
        with tempfile.TemporaryDirectory(prefix="golf-act-source-check-") as temp:
            copy = Path(temp) / "act"
            shutil.copytree(root, copy)
            change(copy)
            try:
                verify(copy, manifest)
            except ValueError:
                continue
            raise AssertionError("source tampering was accepted")
    return len(changes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-dir", type=Path)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((HERE / "upstream_source_manifest.json").read_text())
    root = HERE / "third_party/act"
    count = verify(root, manifest, args.upstream_dir)
    rejected = self_check(root, manifest) if args.self_check else 0
    print(json.dumps({"status": "source_verified", "files": count,
                      "sourceCommitId": PIN["sourceCommitId"],
                      "patchSha256": manifest["patchSha256"],
                      "independentUpstream": args.upstream_dir is not None,
                      "tamperCasesRejected": rejected}, sort_keys=True))


if __name__ == "__main__":
    main()

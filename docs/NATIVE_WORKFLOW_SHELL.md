# Cloudflare native PR shell workflow profile

An operator can select one bounded workflow file for native PR evidence jobs.
The existing `tests` Container allocation accepts either `module` for the Python
profile or `workflow` for this profile:

```json
{
  "tests": {
    "image": "golf-pr-tests:approved",
    "image_id": "sha256:<the inspected 64-hex Docker image ID>",
    "workflow": { "format": "actions", "path": ".github/workflows/pr.yml" }
  }
}
```

Use `"format": "gitlab", "path": ".gitlab-ci.yml"` for GitLab syntax.
The operator still supplies the existing `evidence` allocation. The image is
pinned at preparation by exact Docker image ID. Native agents require the Python
module profile and cannot share a workflow allocation.
The installation command accepts `--test-workflow-format actions|gitlab` and
`--test-workflow-path` with `--test-image` and `--test-image-id`; these replace
`--test-module`. A profile change pins a new policy digest, so queued jobs from
the previous profile are refused at dispatch.

The Actions profile accepts `on: pull_request`, one job with
`runs-on: golf-native-linux`, and up to ten `run` steps. Optional `name` and
`shell: sh|bash` are accepted. Each step gets a fresh shell in the same checkout.
The default shell runs Bash with `-e`; explicit Bash also enables `pipefail`.

The GitLab profile accepts one job with `script` and optional `stage`,
`before_script`, and `after_script`. `before_script` and `script` share one
shell; `after_script` runs in a separate shell after a normal success or failure.
Its exit code does not replace the main script exit code. After-script execution
stops when the job is cancelled, timed out, or loses authorization. An optional
single `stages` entry must match the job stage when both are supplied.
`CI_JOB_STATUS` is `success` or `failed` in the after-script shell.

At admission Golf reads the approved file from the exact PR head tree, parses
the whole YAML document, rejects duplicate keys, aliases, tags, unknown fields
and unsupported constructs, and stores the compiled plan with its blob and plan
hash. The Container clones the exact commit and verifies the workflow blob again
before executing. Each step rechecks current authority. The network broker only
serves the admitted Git clone and, if separately enabled, the exact job's CFCR
tag. Results bind the commit, tree, profile revision and workflow hash; success
is published only after Container destruction. The public evidence report omits
script bodies and records source coordinates and hashes.

Limits: 32 KiB YAML, 16 KiB total script, ten commands/steps, 60 seconds per
shell, the existing ten-minute job deadline and 64 KiB combined output. The
profile does not admit `uses`, expressions, secrets, job images, services,
artifacts, caches, matrices, dependent jobs, GitLab rules/includes, or provider
token APIs. These forms fail admission. The approved image supplies the tools
the shell scripts need; `golf-native-linux` does not promise an Ubuntu hosted
runner image. Full Actions and GitLab compatibility, user-managed runner pools,
and a workflow settings editor remain separate P5 gates.

Local checks: `node --test cloudflare/forge/native-workflow.test.mjs
cloudflare/forge/test-worker.test.mjs` and `make cloudflare-check`. Disposable
hosted Containers passed both supported profiles, including successful and
deliberately failing jobs, stale evidence, reader revocation and complete owned
resource cleanup. The [sanitized hosted receipt](compatibility/evidence/native-workflow-shell-hosted-20261012.json)
records the exact scope. Production profile migration remains open.

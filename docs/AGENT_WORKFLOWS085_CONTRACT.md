# Agent workflows085

This packet extends existing reviewer admission, native publication and the private attempt journal. It does not enable Cloudflare, additional Docker capacity or inference during qualification. AI remains optional.

## PR comment instructions

With an enabled, unexpired reviewer and `respond_to_mentions`, the sponsoring native owner or current PR author may mention the configured publishing persona on an open, nondraft, same-repository PR. The current first50 comments/PRs,25 configured repositories/pass and20 hourly/outstanding admissions/repository boundaries remain. Arbitrary collaborators, fork execution, shell instructions, merges and deployment are not admitted by a mention.

Admission independently reads the direct native comment and this PR's inventory. Its exact positive native ID, current author and body digest enter an immutable body-free085 journal linked to the original reviewer run, pinned comparison and sponsor/policy revision. Before queuing, during worker lease/observation checks and immediately before native publication, the same association, author eligibility and digest must still hold. Changed/deleted instructions and historical comment runs without this receipt fail closed. A comment ID is an original intent across later PR heads; polling never adopts or replays that intent. Native reads are observations, not an atomic native comment/publication transaction.

Review settings explain the concrete mention command without displaying a bare form. Actions retains the reviewer run and its authorized private child task. The sponsor's private model account and conversation do not become visible to every reader of published findings.

## OpenCode review progress

The existing pinned CLI stdout is now parsed while the process runs. When native `sessionID`, `part.messageID` and text `part.id` are present, actual completed message/usage/turn observations are acknowledged through the existing encrypted conversation journal and lease/current-policy guards. A rejected acknowledgement kills the controlled process; result consumption does not require buffering all output until exit. Native commands, tool arguments, stderr, provider failures and reasoning are not copied to this journal. Tools remain prohibited by the existing review-only policy.

Bodies remain WITHHELD until final initial/refreshed credential screening. Results are independently validated before publication. A native version omitting identity metadata preserves its independently validated final result and exposes the journal as UNAVAILABLE; no session/message identity is fabricated. Very large captured comparisons retain a labeled bounded request excerpt plus the full dispatched-request SHA-256/byte count rather than falsely presenting an excerpt as the complete prompt. This is completed-message/progress delivery, not live token streaming.

## Executable ACP v1 adapter

`internal/runner/acp.go` implements actual newline-delimited JSON-RPC v1 initialization/session negotiation, sequential prompt/reply, cancel, permission decisions and negotiated `session/resume`. It requires current-authority gating, committed original outgoing intent acknowledgements and accepted bounded observations. A failed/lost transport acknowledgement never causes a resend. One native process owns a session; competing prompts, unknown sessions, duplicate permission requests and malformed/oversized frames fail closed. The adapter grants no host filesystem, terminal, authentication or MCP client capabilities. Permission defaults to cancelled; only an exact `allow_once` decision can be selected. `allow_always` cannot widen persistent authority. Reasoning/provider diagnostic updates are omitted. Adapter-local `golf-turn-*`/`golf-message-*` identities are explicit where ACP does not provide native IDs; they are not native provenance.

In-flight steer is not an ACP-v1 baseline and is refused. Loading history does not dispatch a prompt or restore context. Resume requires the advertised native capability and the original isolated workspace/session; it is distinct from transcript replay.

This adapter has an executable duplex fixture and an opt-in actual installed OpenCode initialization/session test without a prompt, inherited credentials or user configuration. Installed2.0.16 is distinct from Docker's pinned1.18.34. The adapter is **not enabled in the managed worker/browser**: qualification of that exact image, policy-controlled permission UI/outgoing durable command delivery, preserved sandbox context, actual model/auth rotation, recovery and parent-workflow lifecycle remains required. No unqualified ACP controls or first-class agent workflow action are advertised. Ordinary workflow embedded-agent execution and all-five-harness qualification remain open.

Primary protocol references: [OpenCode ACP](https://opencode.ai/v2/docs/cli/acp/), [ACP v1 prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn), [initialization](https://agentclientprotocol.com/protocol/v1/initialization). OpenCode can advertise session metadata before session/new acknowledges; the adapter binds that metadata to the ensuing exact receipt without turning it into a prompt event.

## Qualification

Run `go test -race ./internal/runner -run 'TestACP|TestReview'` for native-framing, reply/cancel/permission/resume, lost acknowledgement, revocation, foreign identity, reasoning exclusion and real subprocess-before-completion acknowledgement. `GOLF_TEST_ACP_BINARY=/absolute/opencode go test ./internal/runner -run TestACPNativeOpenCodeSession` performs actual no-model initialization/session only.

Use isolated host PostgreSQL with `GOLF_TEST_DATABASE_URL` for `TestAgentCommentAuthorityPostgres` and existing reviewer publication/conversation/task matrices. The opt-in native launcher `scripts/reviewer-publication-native-proof.py --stack-root PATH --database-url URL --output PATH` uses supported owned Forgejo APIs and ephemeral native actors, passes credentials only through a removed owner-private envelope, creates no new Docker resources with a supplied host database and purges fixtures. Its recorded run used the since-retired backend and has not been repeated on Forgejo 15.0.9. It qualifies actual command capture/edit/delete and original publication helpers, not paid execution, served rollout or complete agent parity. Source/browser/native/runtime evidence must be recorded separately by the root ledger.

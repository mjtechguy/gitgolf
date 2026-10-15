# Engines (Cloudflare native)

Status: phase 2a of [AGENTS_AND_AUTOMATIONS_PLAN.md](AGENTS_AND_AUTOMATIONS_PLAN.md), verified locally. Not yet hosted-verified.

An engine is what does the thinking. Engines are chosen per AI use case at installation, organization and repository level. This
replaces per-use-case model selection: when nothing is chosen, a use case runs the Workers AI model chosen in **AI models**, exactly as
before. Code: `cloudflare/forge/src/engines.mjs`; schema 45; credentials come from the [credential vault](CREDENTIAL_VAULT.md).

## Kinds

| Kind | What it is | Credential | Places |
| --- | --- | --- | --- |
| `cloudflare-model` | a Workers AI model from the deploy list (`AI_MODELS`), through the private AI Gateway | none | cloud |
| `provider-model` | an OpenAI, Anthropic, xAI or Google model through the same gateway | an API key of that provider, from the same scope | cloud |
| `coding-cli` | Codex, Claude Code, OpenCode, Grok Build, Antigravity or Muse Code, with an optional credential | an API key or the tool's sign-in, from the same scope | agent-host, ssh-host (cloud later) |

- **Built-in engines:** one `cloudflare-model` engine per text-generation model on the deploy list, with id `workers-ai:<model>`. They are
  not stored.
- **Stored engines:** live in `engines` at `user`, `organization` or `installation` scope. Each scope's managers edit them: the owner,
  organization owners, or operations administrators.
- **Coding CLI engines:** descriptors only. Agent hosts, SSH hosts and later cloud sandboxes run them through tasks; `runChat` refuses them.

## Selection and precedence

`engine_selections` holds one row per scope and use case. Each row names an engine (`''` means follow the level above) and whether the
levels below may choose (`allow_override`). Resolution for a repository:

1. **Installation:** its choice applies everywhere. With no row, or an empty choice, the AI models default applies.
2. **Organization:** counts only while the installation allows overrides. Its own `allow_override` then decides for its repositories.
3. **Repository:** counts only while every level above allows it. Repository administrators choose, under a verified Access sign-in.

Withdrawing an override makes the lower choices stop counting at once; they are kept, not deleted.

Each level can choose only engines it can reach: built-ins and installation engines, plus, at organization or repository level, that
organization's engines. A selected engine that is disabled, deleted, a coding CLI, outside the organization, or whose Workers AI model AI
models no longer allows falls back to the default **with a note**. If the person starting the run may not use the engine's credential, the
run is **refused** (412, audited as `credential.use_denied`); Golf never swaps in a different engine.

## Use cases

| Use | Selectable | Default |
| --- | --- | --- |
| `review-drafts` (review drafts and agentic inbox intent summaries) | yes | AI models `review-drafts` |
| `release-notes` | yes | AI models `release-notes` |
| `automations` (default engine for the automation framework) | yes | AI models `review-drafts` |
| `triage`, `advice` | no: Clef answers constrained choices with calibrated probabilities | Clef |
| `agents` (agent proposals) | no: OpenCode runs on Workers AI and the model is bound into the proposal policy identity | AI models `agents` |
| `search` | no: embeddings | AI models `search` |

## AI runs

- **Admission:** `createAiRun` resolves the engine with `resolveEngine`. `ai_runs.model` records the Workers AI model or
  `<provider>/<model>`.
- **Stored engine:** a run on a stored engine also gets an `ai_run_engines` row (engine id and version, credential id and label).
- **Prepare and infer:** before preparing and again before inference, the run must still be allowed. The engine must exist, be enabled and
  have the same version, and the requester must still be allowed its credential. Otherwise the run is refused with "nothing was billed".
  Default runs keep the old check, `aiModelStillAllowed`.
- **Inference:** one call, through `aiRun` (Workers AI) or the provider path. `ai_runs.usage` records exactly the token counts the
  provider reported.

## Provider calls

Provider requests use the Workers AI binding's gateway: `env.AI.gateway(EVIDENCE_GATEWAY).run({ provider, endpoint, headers, query })`.
Binding requests are pre-authenticated to the account's authenticated gateway, so no `cf-aig-authorization` token is needed.

| Provider | Gateway provider / endpoint | Key header | Body |
| --- | --- | --- | --- |
| OpenAI | `openai` / `chat/completions` | `authorization: Bearer` | `model`, `messages`, `max_completion_tokens`, `response_format` |
| xAI | `grok` / `v1/chat/completions` | `authorization: Bearer` | `model`, `messages`, `max_tokens`, `response_format` |
| Anthropic | `anthropic` / `v1/messages` | `x-api-key`, `anthropic-version: 2023-06-01` | `model`, `max_tokens` (default 4096), `system`, `messages` |
| Google AI Studio | `google-ai-studio` / `v1beta/models/<model>:generateContent` | `x-goog-api-key` | `contents`, `systemInstruction`, `generationConfig` |

- **Requested JSON shape:** for Anthropic and Google, a requested JSON schema is added to the system text. Google also gets
  `responseMimeType: application/json`.
- **Answers:** every answer is normalized to `choices[0].message.content`, `finish_reason` (`stop` or `length`) and usage counts, so the
  existing AI kinds read it unchanged.
- **Request headers:** each request sets `cf-aig-skip-cache: true` and `cf-aig-collect-log: false`. The gateway itself keeps no logs.
- **The key:** it is opened from the vault at the moment of the call and placed only in the outbound headers. It is never in the body,
  never logged, never stored elsewhere. An error that might echo it becomes a fixed message.
- **Deprecation:** the binding's universal `run` is deprecated in favour of the OpenAI-compatible and provider-native gateway URLs. A
  `fetch` to those URLs from an authenticated gateway would need a gateway token binding. Golf uses the binding until that exists.

## The automations interface (stable)

```js
import { listEngines, resolveEngine, runChat } from './engines.mjs';

// Every engine the person can see there: built-ins, installation engines, the organization's engines, their own.
// Each view has { id, name, kind, provider, model, tool, places, scope, credential: { label, kind, state } | null,
//   enabled, builtIn, usable, reason }. Nothing is audited or opened.
await listEngines(db, env, person, { repository /* row */ } | { organizationId } | {});

// A frozen handle { use, engine, model, source, note, credential, place }. Throws Fault 412 on refusal.
// engineId picks an engine explicitly; otherwise the selection chain decides.
// useCase is 'review-drafts' | 'release-notes' | 'automations' | ...
const handle = await resolveEngine(db, env, { person, repository, useCase: 'automations', engineId, place: 'cloud' });

// For cloudflare-model and provider-model handles from resolveEngine only.
const { text, usage, finishReason } = await runChat(env, handle, [{ role: 'system', content }, { role: 'user', content }],
  { maxTokens, responseFormat, deadlineMs });
```

`engineCall(env, handle, input, options)` is the lower-level call the AI kinds use: Workers AI-shaped input in, a chat-completions answer out.

## API and UI

`POST /native/engines`:

| Action | Fields |
| --- | --- |
| `list` | `scope` `user` / `organization` / `installation` / `repository`, plus `organization` or `repository` + `repositoryId` |
| `create` | `name`, `kind`, `provider`, `model`, `tool`, `credentialId`, `places`, `enabled` |
| `update` | `id`, `expectedVersion`, and the fields to change |
| `delete` | `id`; refused while a selection uses the engine |
| `select` | `use`, `engineId`, `allowOverride`, `expectedVersion` |

- **Audit:** category **Engines** (`engine.*`, `engine_selection.update`), written in the same batch as each change.
- **UI:** Admin → Engines (`/admin/engines`); Organization settings → Engines; repository settings (an Engines panel under AI models);
  personal engines under Settings → Credentials and engines.
- **AI models:** `/admin/ai` stays as it was and now says that an engine chosen in Engines takes precedence for summaries, review drafts
  and release notes.

**Capability** `settings.engines` is ready with schema 45 and approved Workers AI. Its reason says when provider models are unavailable:
no gateway binding or gateway id.

## Deploy changes needed

None. Provider engines need the existing `AI` binding with `EVIDENCE_ALLOW_AI=true` and `EVIDENCE_GATEWAY`. The vault needs the existing
`EXECUTION_VALUE_KEY`.

## Not done

- Hosted evidence against real providers. Request shapes are tested against a mocked gateway only.
- Per-user spend caps per credential; only the installation's daily AI run limit applies.
- A feature-policy switch for provider models.
- Running coding-CLI engines: they are descriptors until the automations and cloud-sandbox phases.
- Teams as grantees, because Golf has no teams yet.

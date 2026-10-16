# Golf: Cloudflare Git challenge readiness

Reviewed: 2026-10-07. **Golf is not yet a competition-ready entry.** Local collaboration and bounded CI execution provide a foundation; live concurrent-agent Cloudflare execution, application provisioning and protected previews remain to be qualified. The draft [Cloudflare build and scale plan](CLOUDFLARE_BUILD_PLAN.md) gives the proposed implementation sequence and acceptance gates.

This review preserves the private repository, existing licensing state and the instruction to add no repository CI workflows. It does not submit an entry, accept terms, establish eligibility or authorize publication.

**Competition scope is the Cloudflare track only.** The self-hosted product must run independently in Docker Compose and Kubernetes with no Cloudflare requirement; the current developer preview has Compose and Helm packaging with isolated single-node Kubernetes qualification; production topology, recovery and broader execution remain open. Operators may opt into individual Cloudflare backends without adopting the entire Cloudflare track. Workers, Artifacts and concurrent AI-agent execution are requirements of this competition variant, not installation prerequisites for Golf's portable core.

## Verified source requirements

The [official challenge page](https://www.cloudflare.com/git-competition/) and [announcement](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) describe a new Git collaboration experience in which multiple agents work concurrently. Workers and Artifacts are required technologies, also explicitly confirmed by a checkbox on the [submission form](https://www.cloudflare.com/git-competition/submit/). The announcement requires permissively licensed source, such as MIT, Apache or BSD; a 5–10-minute demonstration; and instructions for running or trying the project.

The submission cutoff is **October 14, 2026 at 11:59 p.m. Pacific daylight time**, or October 15 at 06:59 UTC. The rules require Workers, Artifacts and concurrent agents, a 5–10 minute demonstration, runnable source and an MIT, Apache 2.0 or BSD 2/3 license with a LICENSE file. Source: [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf).

The form accepts MP4, WebM or MOV video files up to 2 GiB. It asks for team/contact/location/attendee information, project vision, explanation of Cloudflare use, an open-source repository URL and run instructions. It requires confirmation of the terms and states that submitted details/video are retained for up to 180 days. This review read the form without entering data or accepting anything. Source: [submission form](https://www.cloudflare.com/git-competition/submit/).

The [official competition terms (PDF)](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) are now accessible. Judging weights originality/prototype quality at 50%, multi-agent concurrency/coordination/context/review/conflict handling at 25%, and usability at 25%. The rules restrict entrants to eligible adults legally resident in the United States or Canada; personal eligibility and publication/submission choices remain owner decisions. Finalist presentations are October 21 in San Francisco.

Do not borrow rules from [The Cold Start](https://www.cloudflare.com/connect/cold-start/), a separate Cloudflare contest. This Git challenge's verified rubric is the one above. Broad service use should support observable application provisioning and collaboration outcomes.

## Requirement and evidence matrix

| Requirement / decision | Existing plan coverage | Current evidence | Needed before claiming ready |
| --- | --- | --- | --- |
| A useful new workflow for agents working concurrently | Sections 9.7, 21, 22; P5.2, P8.10 | Specified only; no concurrent execution in bootstrap | Real overlapping runs, independent task repositories, visible comparison and integration outcome. |
| Workers and Artifacts actually used | Sections 2.5/2.7, 10, 21/22; P0.6/P0.10, P6.2/P6.9 | No live integration evidence in this review | Worker deployment, Artifacts forks/tokens/events and resource IDs tied to demonstrated commits. |
| Permissive source and accessible repository | Section 13.5; P0.8 | Repository requested private; plan license intention alone is insufficient | Review dependency licenses/notices and actual submission terms; obtain explicit owner authorization for the specific open-source publication. |
| 5–10-minute video | Section 22 | Storyboard exists; no completed recording | Real captured workflow, measured duration, visible evidence and clearly identified edited waits. |
| Reproducible instructions | P8.7/P8.10; bootstrap README/Compose | Initial local setup is being implemented and checked | Clean-machine rehearsal of the demonstrated Cloudflare path, prerequisites, provider plan/cost, fixture data and cleanup. |
| Deadline and eligibility | Section 21 | Exact cutoff and rubric verified from official rules | Verify entrant eligibility and prepare the entry before the cutoff. |
| Honest scale claim | Sections 8/15/22 | No relevant load results in bootstrap | Publish actual concurrency, inputs, resource limits, queue behavior, timings, failures and cost. |
| Useful broader developer product | Full plan, especially 5/7/11/12 | Narrow user-token/repository slice; later capabilities disabled | Prioritize demonstrated outcomes; qualify each additional integration before adding it to the story. |

Implementation observations here cover the initial repository/authentication slice and its backend tests, not a completed review of every evolving branch. [Implementation status](IMPLEMENTATION_STATUS.md) remains the record of dated local and integration evidence.

## Competition demonstration acceptance

Use a focused developer problem: two agents propose independently tested solutions to the same issue while another task changes a shared base. Golf helps a human compare the proposals, identifies interference, and produces a checked integration candidate. The following are proposed Golf acceptance criteria, not claimed official judging weights:

1. Start at least two real agent runs from one recorded source commit, with visibly overlapping execution intervals. Different harnesses are desirable for the product but are not asserted as a contest requirement. Keep source, prompts, tool versions, model/provider choices and relevant policy in the run manifest.
2. Create an independent Artifacts task repository for each run through the Worker integration. Use scoped Git credentials, bounded execution and clear task identity. Agents cannot overwrite each other's refs, read unrelated credentials or bypass canonical protection.
3. Display live task state, touched files, patches, test results and retained task context. Show which task is working on which concern. Distinguish permission failure, failed tests, cancellation and provider interruption from success.
4. Include one deliberate overlapping change or moved-base scenario. Detect the conflict, preserve both proposals and require tests on the resulting integration commit. A green result from an old base cannot authorize merging the newly combined change.
5. Let a reviewer compare proposals using exact commits, tests and measured cost/time, then choose or combine them. Record why a candidate was rejected or selected. The chosen output must remain inspectable through ordinary Git operations.
6. Deliver a real protected preview with isolated D1/R2/AI application resources and an approved DNS hostname. Show unauthenticated denial, authorized reviewer access and alternate-host protection, and publish stable plus immutable links through the supported PR API. This is a requested Golf showcase acceptance target; it is not an additional official competition requirement.
7. Demonstrate cancellation and resource cleanup. Publish a bounded scale run separately from the short recording, with actual concurrency and resource limits. The challenge's large-scale vision is not evidence that Golf already supports hundreds of thousands of live agents.
8. End with concise architecture and reproducibility: why Workers and Artifacts participate in the demonstrated operation, what the Forgejo/origin core owns, which features remain planned, and how another developer can run it.

Suggested 8-minute sequence: problem and source state (45 seconds), concurrent agents and isolated repositories (2 minutes), comparison/context/conflict handling (2 minutes), checked integration and protected preview where verified (90 seconds), failure/cleanup/cost evidence (1 minute), architecture and run instructions (45 seconds). Record real results; label any time compression.

Golf's regular developer workflows remain usable without AI. The **competition recording must include real concurrent agents**; the separate AI-disabled product rehearsal cannot replace that requirement. Section 22's optional-agent language applies to the general product demo, not to this competition variant.

## Cloudflare services justified by this demonstration

| Service | Concrete role | Inclusion condition |
| --- | --- | --- |
| Workers | Authenticated task admission/status and Artifacts control operations | Required contest technology; use the shared Golf policy boundary, not a second unrestricted control plane. |
| Artifacts | Per-task Git forks, scoped tokens, isolated changes and event handoffs | Required contest technology; verify current limits and account access with the real fixture repository. |
| Sandbox / Containers | Isolated concurrent agent/test execution | Qualify an actual runtime and cleanup behavior; select the smallest supported execution path. |
| R2 | Immutable test logs, screenshots and result artifacts tied to candidates | Include once the comparison UI consumes real evidence from it. |
| Queues, Workflows or Durable Objects | Durable task delivery, retry or live coordination | Select the component needed by a measured workflow; avoid duplicating authoritative run state. |
| Access and Workers preview delivery | Reviewer-visible protected running change | Include once authentication, alternate hostnames, expiry and exact-output checks pass. |
| Email / webhooks / Issues | Developer request intake or production-incident-to-repair extension | Add after the core concurrent-agent story works; each event must retain authenticated provenance and bounded authority. |
| Workers AI / AI Gateway | Supported optional inference and usage controls | Use only a qualified harness/provider combination; provider names on a diagram do not establish execution. |

Artifacts' [open-beta changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/) identifies Workers Paid plan availability and describes task repository bindings/events and Builds handoffs. Its billing start date says October 14, while the same-day [announcement](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) says October 15. Confirm actual pricing/account billing before enabling paid resources; the source discrepancy is unresolved here.

## Next implementation priorities

Follow CF0–CF5 in the [Cloudflare build and scale plan](CLOUDFLARE_BUILD_PLAN.md) for the current competition milestone. Its requested scope includes Clef, inference APIs, D1/R2 application provisioning and DNS/Zero Trust-protected PR previews. The earlier portable sequence below remains the dependency context; live provider qualification may proceed alongside corresponding portable consumers without requiring the entire local roadmap to finish first.

1. Finish and record the current portable bootstrap verification. Keep it as the foundation; do not present it as the challenge's core innovation.
2. Pull the smallest concurrent-task slice forward from P5.2/P6.2/P6.9: task identity and run manifest, Worker-to-Artifacts fork/token flow, two real supported agent runs, cancellation, and result comparison. Complete the relevant account/harness proofs before calling this available.
3. Implement exact-commit test evidence and conflict-aware candidate integration. Use one bounded integration queue, with stale-base invalidation and retest; speculative merge trains can wait for measured need.
4. Add the most useful verified extension: protected previews and candidate screenshots. Bring email/webhook intake and production-issue repair only when their real integration is ready and fits the recording.
5. Rehearse clean setup and resource teardown, record measured concurrency/cost, and prepare the demo and run instructions. Keep all unpublished assets private.
6. Separately resolve rules/eligibility, dependency licensing, public-source approval and submission authorization. No form submission, publication, account purchase or terms acceptance occurs merely because the product is technically ready.

No new repository CI workflow is necessary for this work; local tests, recorded checks and manually invoked controlled provider proofs remain the authorized verification path.

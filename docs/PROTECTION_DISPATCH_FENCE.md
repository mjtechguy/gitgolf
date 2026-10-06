# Uncertain protection updates and later managed writes

The083 consumer closes a Golf-managed dispatch gap. Previously an accepted but
unacknowledged branch/tag/merge-rule update blocked another rule operation but
did not necessarily block a file, ref, review, collaborator or wiki operation.
The rule could still change native policy after those later preflight reads.

The shared native request boundary now checks the exact repository's durable
rule journal before dispatching a repository mutation. `RESERVED` and
`DISPATCH_UNKNOWN` refuse later writes, including writes carrying another
consumer's otherwise valid permit. File/ref reservation locks and qualified
managed Git WRITE prerequisites perform the same check. Reads and original
operation inspection remain available; an unrelated repository is unaffected.

Only the original rule dispatcher constructs the private own-operation permit.
It binds journal row/user/native actor/forge/repository, dispatch phase, exact
method/path and canonical payload digest. Original replay returns the saved
outcome before constructing this permit and never sends the update again. A
restart, timeout, vanished browser session or matching external configuration
does not remove the uncertainty fence.

This is not complete protected publication. Independent native web/API/SSH,
background writers, organization-wide authorities, accepted native effects,
trusted candidate checks, effective approval eligibility and atomic H/B/C/P/A/E/F
publication remain the gates in [ADR0004](decisions/0004-protected-integration-enforcement.md).
Managed WRITE enrollment and protected merge remain unavailable without their
separate native qualification. This increment does not enable either.

`TestProtectionUnknownFencesManagedWritesPostgres` exercises real PostgreSQL,
accepted-response loss, original replay, restart, exact permit refusal and zero
subsequent managed dispatches. Existing rule/file/ref/Git regression tests check
successful originals and narrower consumers. The actual native qualifier is
`scripts/protection-dispatch-native-proof.py --stack-root PATH --output NEW_DIR`
with an owned host PostgreSQL database. It uses one disposable ordinary native
actor, performs one real accepted rule update, drops that acknowledgement,
independently observes the effect and proves later managed writes/replay/restart
remain fenced. It purges the owned actor/repository and creates no Docker jobs,
services, Cloudflare resources or model execution.

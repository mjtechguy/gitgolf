# Working on Golf

Read `GOLF_IMPLEMENTATION_PLAN.md` and `docs/IMPLEMENTATION_STATUS.md` before changing product scope.

- The initial forge is Gitea on both infrastructure tracks. Use supported APIs; do not write Gitea's database or repository files directly.
- AI and Cloudflare are optional for the portable core. Expose capability states honestly; do not substitute mock successes for missing integrations.
- Keep tenant/user authorization and credential handling explicit. Never commit provider tokens, local keys, environment files or runtime data.
- No repository CI workflows yet. Run applicable checks locally and record the result. This restriction does not remove Golf's planned CI/CD product features.
- Prefer existing code, native platform facilities and small changes. Do not scaffold future subsystems.
- In parallel work, assign disjoint file ownership and coordinate API contracts before editing.
- Do not mark roadmap tasks verified without runnable evidence. Document narrower initial slices and remaining acceptance criteria.

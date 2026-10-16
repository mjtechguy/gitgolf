# Working on Golf

Read `GOLF_IMPLEMENTATION_PLAN.md` and `docs/IMPLEMENTATION_STATUS.md` before changing product scope.

- Forgejo is Golf's portable backend; read ADR 0009 and `docs/FORGEJO_SETUP.md` before provider changes. The earlier backend was retired on 2026-10-16. Cloudflare-native remains Artifacts/D1/Workers. Application features use supported APIs; do not write Forgejo's database or repository files directly. The explicit P1.6 exception is privileged offline recovery using documented native PostgreSQL/Docker procedures into a fresh, stopped target, with all writers drained and traffic quarantined; see `docs/RECOVERY.md`. This does not authorize direct forge writes, cross-product schema surgery, or ad hoc edits to a live installation.
- AI and Cloudflare are optional for the portable core. Expose capability states honestly; do not substitute mock successes for missing integrations.
- Keep tenant/user authorization and credential handling explicit. Never commit provider tokens, local keys, environment files or runtime data.
- No repository CI workflows yet. Run applicable checks locally and record the result. This restriction does not remove Golf's planned CI/CD product features.
- Prefer existing code, native platform facilities and small changes. Do not scaffold future subsystems.
- In parallel work, assign disjoint file ownership and coordinate API contracts before editing.
- Do not mark roadmap tasks verified without runnable evidence. Document narrower initial slices and remaining acceptance criteria.

- Product settings lead with current values/inventories and explicit Add/New/Edit actions; forms open only on request. Use TanStack Form, the shared DataTable configuration for searchable/sortable inventories, and global styles.css tokens/classes. Avoid page-specific table engines or inline styling; loaded-page search/sort must be labeled honestly.

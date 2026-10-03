import { useLayoutEffect, useRef, useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { clone } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { Check, LoaderCircle, MessageSquare, Send, ShieldAlert, X } from 'lucide-react';
import { errorMessage, repositoryClient } from './api';
import { forgetPrivateQueries } from './queryClient';
import { MarkdownBody } from './RepositoryContent';
import { parseDiff } from './diff';
import { draftNumber, draftUUID, sameDraftTarget, validateDraft } from './reviewDrafts';
import { IssueState, PullInlineReviewPhase, PullRequestReviewState, PullReviewDraftSchema } from './gen/golf/v1/golf_pb';
import type { PullInlineReviewMutation, PullRequest, PullReviewDraft, PullReviewDraftTarget, User } from './gen/golf/v1/golf_pb';

type Intent = { operationId: string; draftId: string; version: string; generation: string; comparisonId: string; decision: PullRequestReviewState; entryCount: number };
type Props = { target: PullReviewDraftTarget; userId: string; draft: PullReviewDraft | null; targetGeneration: string | null; pull: PullRequest; blocked: boolean; dirty: boolean; onDenied: () => void };
const decisions = [PullRequestReviewState.COMMENT, PullRequestReviewState.APPROVED, PullRequestReviewState.REQUEST_CHANGES];
const labels = { [PullRequestReviewState.COMMENT]: 'Comment', [PullRequestReviewState.APPROVED]: 'Approve', [PullRequestReviewState.REQUEST_CHANGES]: 'Request changes' };
const submissionLabels = { [PullRequestReviewState.COMMENT]: 'comment', [PullRequestReviewState.APPROVED]: 'approval', [PullRequestReviewState.REQUEST_CHANGES]: 'change request' };
const objectID = (v: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const date = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
function readIntent(key: string): { intent: Intent | null; invalid: boolean } {
  try {
    const raw = sessionStorage.getItem(key); if (!raw) return { intent: null, invalid: false };
    const v = JSON.parse(raw) as Intent;
    if (!v || Object.keys(v).sort().join(',') !== 'comparisonId,decision,draftId,entryCount,generation,operationId,version' || !draftUUID(v.operationId) || !draftUUID(v.draftId) || !draftUUID(v.comparisonId) || !draftNumber(v.version) || !draftNumber(v.generation) || !decisions.includes(v.decision) || !Number.isInteger(v.entryCount) || v.entryCount < 1 || v.entryCount > 20) throw new Error('Invalid saved publication identity.');
    return { intent: v, invalid: false };
  } catch { return { intent: null, invalid: true }; }
}
function observe(v: PullInlineReviewMutation | undefined, intent: Intent, target: PullReviewDraftTarget, original: PullReviewDraft | null) {
  if (!v || v.operationId !== intent.operationId || v.draftId !== intent.draftId || v.acceptedVersion !== intent.version || v.acceptedTargetGeneration !== intent.generation || v.comparisonId !== intent.comparisonId || v.decision !== intent.decision || !sameDraftTarget(v.target, target) || !v.target?.repository?.owner || !v.target.repository.name || ![PullInlineReviewPhase.RESERVED, PullInlineReviewPhase.DISPATCH_UNKNOWN, PullInlineReviewPhase.SUCCEEDED, PullInlineReviewPhase.REJECTED].includes(v.phase) || !objectID(v.baseTipCommitId) || !objectID(v.mergeBaseCommitId) || !objectID(v.headCommitId) || v.baseTipCommitId.length !== v.headCommitId.length || v.mergeBaseCommitId.length !== v.headCommitId.length || !/^[a-f0-9]{64}$/.test(v.diffSha256) || !date(v.createdAt) || !date(v.updatedAt) || v.observedReviewId !== '' && !draftNumber(v.observedReviewId)) throw new Error('The publication receipt does not match the original saved version. Keep its operation ID and inspect status.');
  const capture = original?.comparison?.capture;
  if (capture && (v.baseTipCommitId !== capture.selection?.baseCommitId || v.headCommitId !== capture.selection?.headCommitId || v.mergeBaseCommitId !== capture.mergeBaseCommitId || v.diffSha256 !== capture.diffSha256)) throw new Error('The publication replaced the original comparison. Keep its operation ID and inspect status.');
  if (v.phase === PullInlineReviewPhase.SUCCEEDED ? !draftNumber(v.observedReviewId) || v.verifiedCommentIds.length !== intent.entryCount || new Set(v.verifiedCommentIds).size !== intent.entryCount || v.verifiedCommentIds.some(id => !draftNumber(id)) : v.verifiedCommentIds.length !== 0 || [PullInlineReviewPhase.RESERVED, PullInlineReviewPhase.REJECTED].includes(v.phase) && v.observedReviewId !== '') throw new Error('The publication child proof is incomplete or inconsistent. Its outcome remains unresolved.');
  return v;
}

export function PullReviewDraftPublication({ target, userId, draft, targetGeneration, pull, blocked, dirty, onDenied }: Props) {
  const client = useQueryClient();
  const storageKey = `golf.private-review-publication.v1:${userId}:${target.repositoryId}:${target.pullRequestId}`;
  const initial = useRef(readIntent(storageKey));
  const [intent, setIntent] = useState(initial.current.intent), [invalid] = useState(initial.current.invalid);
  const [opened, setOpened] = useState(Boolean(initial.current.intent) || invalid), [record, setRecord] = useState<PullInlineReviewMutation | null>(null);
  const [error, setError] = useState<Error | null>(null), [busy, setBusy] = useState(false), [denied, setDenied] = useState(false);
  const frozen = useRef<PullReviewDraft | null>(null), frozenGeneration = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null), mounted = useRef(false), epoch = useRef(0), latch = useRef(false);
  const onDeniedRef = useRef(onDenied); onDeniedRef.current = onDenied;
  const latest = useRef({ draft, targetGeneration, blocked }); latest.current = { draft, targetGeneration, blocked };
  const form = useForm({ defaultValues: { decision: PullRequestReviewState.COMMENT }, onSubmit: () => publish() });
  const decision = useStore(form.store, s => s.values.decision);
  const active = (id: number) => mounted.current && epoch.current === id && client.getQueryData<User | null>(['session'])?.id === userId;
  function clearPrivate() { epoch.current++; controller.current?.abort(); frozen.current = null; frozenGeneration.current = null; setRecord(null); setDenied(true); setBusy(false); latch.current = false; onDeniedRef.current(); }
  useLayoutEffect(() => {
    mounted.current = true;
    const hide = () => { epoch.current++; controller.current?.abort(); controller.current = null; latch.current = false; frozen.current = null; frozenGeneration.current = null; setRecord(null); };
    const unsubscribe = client.getQueryCache().subscribe(() => { if (client.getQueryData<User | null>(['session'])?.id !== userId) { epoch.current++; controller.current?.abort(); frozen.current = null; queueMicrotask(() => { if (mounted.current) clearPrivate(); }); } });
    window.addEventListener('pagehide', hide); if (initial.current.intent) void send(initial.current.intent, true);
    return () => { mounted.current = false; hide(); unsubscribe(); window.removeEventListener('pagehide', hide); };
  }, []);
  const saved = frozen.current;
  const capture = saved?.comparison?.capture;
  const current = Boolean(capture && saved?.target?.pullRequestId === pull.id && capture.expectedPullRevision === pull.revision && capture.selection?.baseCommitId === pull.base?.commitId && capture.selection?.headCommitId === pull.head?.commitId && capture.mergeBaseCommitId === pull.mergeBaseCommitId);
  const admissible = pull.state === IssueState.OPEN && !pull.draft && !pull.merged;
  const decisionsAllowed = admissible && current && Boolean(pull.user?.id) && pull.user!.id !== userId;
  const sameSaved = Boolean(saved && draft?.id === saved.id && draft.version === saved.version && draft.comparison?.id === saved.comparison?.id && targetGeneration === frozenGeneration.current);
  async function open() {
    if (blocked || busy || intent || invalid || !draft || !targetGeneration) return;
    const id = ++epoch.current;
    try { await validateDraft(draft, target, userId); if (!active(id) || latest.current.blocked || latest.current.draft?.id !== draft.id || latest.current.draft.version !== draft.version || latest.current.targetGeneration !== targetGeneration) return; if (!draftNumber(targetGeneration)) throw new Error('The saved target generation is invalid.'); frozen.current = clone(PullReviewDraftSchema, draft); frozenGeneration.current = targetGeneration; form.setFieldValue('decision', PullRequestReviewState.COMMENT); setDenied(false); setError(null); setOpened(true); }
    catch (failure) { if (active(id)) { setError(failure as Error); setOpened(true); } }
  }
  async function send(pending: Intent, inspect: boolean) {
    if (latch.current) return;
    const id = ++epoch.current; latch.current = true; setBusy(true); setError(null); controller.current = new AbortController();
    try {
      const options = { signal: controller.current.signal, timeoutMs: inspect ? 8000 : 15000 };
      const response = inspect ? await repositoryClient.getPullRequestInlineReviewMutation({ target, draftId: pending.draftId, operationId: pending.operationId }, options) : await repositoryClient.publishPullRequestReviewDraft({ target, draftId: pending.draftId, expectedVersion: pending.version, expectedTargetGeneration: pending.generation, comparisonId: pending.comparisonId, operationId: pending.operationId, decision: pending.decision }, options);
      if (!active(id)) return;
      const observedDraft = latest.current.draft;
      const original = frozen.current || (observedDraft?.id === pending.draftId && observedDraft.version === pending.version && observedDraft.comparison?.id === pending.comparisonId ? observedDraft : null);
      setRecord(observe(response.mutation, pending, target, original)); setDenied(false);
    } catch (failure) {
      if (!active(id)) return;
      const value = failure instanceof Error ? failure : new Error('Publication status unavailable.'); setError(value);
      if (value instanceof ConnectError && [Code.Unauthenticated, Code.PermissionDenied, Code.NotFound].includes(value.code)) { clearPrivate(); if (value.code === Code.Unauthenticated) { client.setQueryData(['session'], null); forgetPrivateQueries(client); } }
    } finally { if (active(id)) { latch.current = false; controller.current = null; setBusy(false); } }
  }
  function publish() {
    if (intent || invalid || latch.current || busy || blocked || denied || !sameSaved || !current || !admissible || !saved || !frozenGeneration.current || !decisions.includes(decision)) return;
    if (decision !== PullRequestReviewState.COMMENT && !decisionsAllowed) return;
    if (saved.entries.length < 1 || saved.entries.length > 20 || decision !== PullRequestReviewState.APPROVED && !saved.summary.trim()) { setError(new Error('Save at least one comment and a review summary. Only approval permits an empty saved summary. No publication was sent.')); return; }
    const files = parseDiff(saved.comparison!.rawDiff).files;
    if (saved.entries.some(entry => { const file = files[entry.coordinate!.fileIndex]; return !file?.valid || !file.path || file.headers.some(header => header === '+++ /dev/null' || header.startsWith('deleted file mode ')) || Boolean(file.oldPath && file.oldPath !== file.path); })) { setError(new Error('This saved version includes unsupported renamed or deleted file comments. Keep your private draft; no publication was sent.')); return; }
    try {
      const pending: Intent = { operationId: crypto.randomUUID(), draftId: saved.id, version: saved.version, generation: frozenGeneration.current, comparisonId: saved.comparison!.id, decision, entryCount: saved.entries.length };
      sessionStorage.setItem(storageKey, JSON.stringify(pending)); setIntent(pending); void send(pending, false);
    } catch { setError(new Error('Writable tab storage and secure operation IDs are required before publication. No request was sent.')); }
  }
  function another() {
    if (record?.phase !== PullInlineReviewPhase.REJECTED || busy || blocked || denied) return;
    try { sessionStorage.removeItem(storageKey); setIntent(null); setRecord(null); frozen.current = null; frozenGeneration.current = null; setOpened(false); setError(null); }
    catch { setError(new Error('The rejected operation ID could not be cleared. No replacement was sent.')); }
  }
  if (!opened) return <><button className="button secondary" disabled={!draft || blocked || busy || !targetGeneration} onClick={() => void open()}><Send size={15} aria-hidden="true"/>Publish saved review</button>{error ? <p className="error" role="alert">{errorMessage(error)}</p> : null}</>;
  const phase = record?.phase;
  return <section className="browser-panel" aria-label="Saved review publication">
    <div className="browser-panel-heading"><h3><Send size={16} aria-hidden="true"/>Publish saved review</h3>{!intent && !invalid ? <button className="icon-button" aria-label="Close saved review publication" title="Close saved review publication" onClick={() => { setOpened(false); frozen.current = null; }}><X size={16}/></button> : null}</div>
    <div className="issue-edit-content">
      {dirty ? <p className="session-notice">Your unsaved working notes remain separate. This action publishes only the saved version shown here.</p> : null}
      {!denied && !blocked && saved ? <><p className="field-help">Saved version {saved.version} · {saved.entries.length} inline comments · Original comparison <code>{saved.comparison!.id}</code></p><details className="metadata-details"><summary>Original saved review and comparison</summary><dl className="review-metadata"><div><dt>Old side (merge base)</dt><dd><code>{capture!.mergeBaseCommitId}</code></dd></div><div><dt>Reviewed head</dt><dd><code>{capture!.selection!.headCommitId}</code></dd></div><div><dt>Target branch tip</dt><dd><code>{capture!.selection!.baseCommitId}</code></dd></div><div><dt>Diff SHA-256</dt><dd><code>{capture!.diffSha256}</code></dd></div></dl><MarkdownBody text={saved.summary || 'No saved summary.'} label="Saved publication summary"/>{saved.entries.map(entry => <article className="private-inline-comment" key={entry.id}><strong>{entry.coordinate?.side === 1 ? 'Old' : 'New'} line {entry.coordinate?.line} · {entry.coordinate?.path}</strong><MarkdownBody text={entry.body} label="Saved publication inline comment"/></article>)}</details></> : null}
      {intent ? <div className="creation-status" role="status"><p>{phase === PullInlineReviewPhase.SUCCEEDED ? 'Published and independently verified against every intended comment and original context. This historical receipt does not establish current approval eligibility or merge readiness.' : phase === PullInlineReviewPhase.REJECTED ? 'Rejected before native dispatch. The exact operation remains inspectable; another attempt requires an explicit new action.' : phase === PullInlineReviewPhase.RESERVED ? 'Reserved. The original request may still be running. Status inspection cannot resume or replace it.' : 'Publication may have taken effect. Its outcome is unknown; inspect the original operation without retrying or publishing remaining comments.'}</p><p className="field-help">{labels[intent.decision as keyof typeof labels]} · Saved version {intent.version} · Operation <code>{intent.operationId}</code></p>{!denied && !blocked && record ? <details className="metadata-details"><summary>Publication receipt</summary><dl className="review-metadata"><div><dt>Phase</dt><dd>{PullInlineReviewPhase[record.phase]}</dd></div><div><dt>Original merge base / head / target tip</dt><dd><code>{record.mergeBaseCommitId}</code><br/><code>{record.headCommitId}</code><br/><code>{record.baseTipCommitId}</code></dd></div><div><dt>Observed review</dt><dd>{record.observedReviewId || 'No verified native review identity'}</dd></div><div><dt>Verified comment IDs, original order</dt><dd>{record.verifiedCommentIds.join(', ') || 'None verified'}</dd></div>{record.failureCode ? <div><dt>Outcome detail</dt><dd>{record.failureCode}</dd></div> : null}</dl></details> : null}<p className="field-help">Reload and status checks only read. The saved private draft is retained; it is not consumed or a native pending review.</p></div> : invalid ? <p className="error" role="alert">Stored publication identity is invalid. A replacement cannot be sent safely from this tab.</p> : !denied ? <form onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}><fieldset className="review-decisions"><legend>Saved review decision</legend>{decisions.filter(value => value === PullRequestReviewState.COMMENT || decisionsAllowed).map(value => <label key={value}><input type="radio" name="saved-review-decision" checked={decision === value} disabled={blocked || busy} onChange={() => form.setFieldValue('decision', value)}/>{value === PullRequestReviewState.APPROVED ? <Check size={16}/> : value === PullRequestReviewState.REQUEST_CHANGES ? <ShieldAlert size={16}/> : <MessageSquare size={16}/>}<span>{labels[value as keyof typeof labels]}</span></label>)}</fieldset>{!current ? <p className="session-notice">This is an earlier or unverified comparison. Preserve the original saved review; native publication requires a fresh matching comparison.</p> : null}{!sameSaved ? <p className="field-help">The saved version changed. Close and explicitly reopen publication before submitting.</p> : null}{!admissible ? <p className="field-help">Publication requires an open, ready, unmerged pull request.</p> : null}<p className="field-help">Golf checks current permissions and existing pending reviews before dispatch. Publication is not an atomic native transaction.</p><button className="button primary" disabled={blocked || busy || !sameSaved || !current || !admissible || decision !== PullRequestReviewState.COMMENT && !decisionsAllowed}><Send size={15}/>Publish saved {submissionLabels[decision as keyof typeof submissionLabels]}</button></form> : null}
      {denied ? <p className="error" role="alert">Current publication access could not be confirmed. Private comparison and receipt details were cleared; the original operation identity remains for status inspection.</p> : null}
      {error ? <p className="error" role="alert">{errorMessage(error)}</p> : null}
      {intent ? <div className="dialog-actions"><button className="button secondary" disabled={busy || blocked} onClick={() => void send(intent, true)}>{busy ? <LoaderCircle size={15} className="spin"/> : null}Check publication status</button>{phase === PullInlineReviewPhase.REJECTED && !denied ? <button className="button secondary" disabled={busy || blocked} onClick={another}>Prepare another saved review attempt</button> : null}</div> : null}
    </div>
  </section>;
}

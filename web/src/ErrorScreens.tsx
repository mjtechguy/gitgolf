import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { RefreshCw } from 'lucide-react';
import { errorMessage } from './api';
import { CopyButton } from './RepositoryUI';

// Full-page and in-panel error states. One line of golf, then the plain facts and a next step.
// Codes and request IDs come from the response itself and are never invented or hidden.
type Scene = 'out-of-bounds' | 'lost-ball' | 'mulligan' | 'rain-delay';
type Heading = 1 | 2;

// Connect's wire name, the same string API clients see.
export const errorCode = (error: unknown) => error instanceof ConnectError ? Code[error.code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() : '';
export const requestId = (error: unknown) => error instanceof ConnectError ? error.metadata.get('X-Request-ID') || '' : '';
// The core answers "not found" whether a resource is missing or hidden from this sign-in, and the screen keeps that ambiguity.
export const hiddenOrMissing = (error: unknown) => error instanceof ConnectError && [Code.NotFound, Code.PermissionDenied].includes(error.code);
export const unreachable = (error: unknown) => typeof navigator !== 'undefined' && navigator.onLine === false || error instanceof ConnectError && [Code.Unavailable, Code.DeadlineExceeded].includes(error.code) || error instanceof TypeError && /fetch|network/i.test(error.message);

function Hole({ scene }: { scene: Scene }) {
  // Tee on the left, flag on the right; where the ball ends up tells the story.
  const flight = { 'out-of-bounds': 'M18 48 Q120 -18 230 52', 'lost-ball': 'M18 48 Q96 -6 150 30', mulligan: 'M18 48 Q60 20 92 50', 'rain-delay': 'M18 48 L40 48' }[scene];
  const ball = { 'out-of-bounds': [230, 52], 'lost-ball': [150, 30], mulligan: [92, 50], 'rain-delay': [44, 48] }[scene];
  return <svg className={`error-screen-hole error-screen-${scene}`} viewBox="0 0 240 64" aria-hidden="true" focusable="false">
    <path className="error-screen-ground" d="M4 56 H236" />
    {scene === 'out-of-bounds' ? <g className="error-screen-stakes"><path d="M208 44 V58" /><path d="M218 44 V58" /></g> : null}
    <path className="error-screen-pole" d="M196 56 V14" /><path className="error-screen-flag" d="M196 14 L214 20 L196 26 Z" />
    <path className="error-screen-flight" d={flight} />
    {scene === 'lost-ball' ? <text className="error-screen-mark" x={ball[0]} y={ball[1]! + 4} textAnchor="middle">?</text> : <circle className="error-screen-ball" cx={ball[0]} cy={ball[1]} r="4" />}
  </svg>;
}

function ErrorScreen({ scene, code, quip, title, level, children, detail, actions, error }: { scene: Scene; code: string; quip: string; title: string; level: Heading; children: ReactNode; detail?: string; actions: ReactNode; error?: unknown }) {
  const Title = level === 1 ? 'h1' : 'h2';
  const wire = errorCode(error), id = requestId(error), heading = useId();
  return <section className="error-screen" aria-labelledby={heading}>
    <Hole scene={scene} />
    <p className="eyebrow error-screen-code">{code}</p>
    <p className="error-screen-quip">{quip}</p>
    <Title className="error-screen-title" id={heading}>{title}</Title>
    <p className="error-screen-body">{children}</p>
    {detail ? <p className="error" role="alert">{detail}</p> : null}
    <div className="error-screen-actions">{actions}</div>
    {wire || id ? <dl className="error-screen-trace">
      {wire ? <div><dt>Code</dt><dd><code>{wire}</code></dd></div> : null}
      {id ? <div><dt>Request ID</dt><dd><code>{id}</code><CopyButton text={id} label="Copy request ID" /></dd></div> : null}
    </dl> : null}
    {id ? <p className="error-screen-hint">Include the request ID when you report this, or hand it to your agent.</p> : null}
  </section>;
}

const home = <Link className="button secondary" to="/">Back to repositories</Link>;
const retryButton = (retry: () => void, primary = false) => <button type="button" className={`button ${primary ? 'primary' : 'secondary'}`} onClick={retry}><RefreshCw size={15} aria-hidden="true" />Try again</button>;

// An address that matches no Golf page.
export function NotFoundScreen({ jump }: { jump: boolean }) {
  return <ErrorScreen scene="out-of-bounds" code="404 · Out of bounds" quip="This hole doesn't exist." title="Page not found" level={1}
    actions={<><Link className="button primary" to="/">Back to repositories</Link>{jump ? <button type="button" className="button secondary" onClick={() => window.dispatchEvent(new Event('golf-jump'))}>Jump to a repository</button> : null}</>}>
    This Golf link does not match an available page. Check the address, or start again from your repositories.
  </ErrorScreen>;
}

// A repository, organization or profile read failed. Missing and hidden look the same on purpose.
export function ResourceError({ error, retry, subject, level = 2 }: { error: Error; retry: () => void; subject: 'repository' | 'organization' | 'profile'; level?: Heading }) {
  if (hiddenOrMissing(error)) return <ErrorScreen scene="lost-ball" code="Unavailable" quip="Lost ball." title={`We can't show this ${subject}`} level={level} detail={errorMessage(error)} error={error} actions={<>{retryButton(retry)}{home}</>}>
    It doesn't exist, or your sign-in can't see it, and Golf won't say which. Check the name, or ask an owner for access.
  </ErrorScreen>;
  if (unreachable(error)) return <OfflineScreen error={error} retry={retry} level={level} />;
  return <ErrorScreen scene="mulligan" code="Error" quip="Mulligan?" title={`Golf could not load this ${subject}`} level={level} detail={errorMessage(error)} error={error} actions={<>{retryButton(retry, true)}{home}</>}>
    {error instanceof ConnectError && ![Code.Internal, Code.Unknown, Code.DataLoss].includes(error.code) ? 'Golf answered with an error, shown above. Try again, or start again from your repositories.' : 'Something went wrong on our side. Try again.'}
  </ErrorScreen>;
}

// The browser is offline or Golf did not answer.
export function OfflineScreen({ error, retry, level = 2 }: { error: Error; retry: () => void; level?: Heading }) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return <ErrorScreen scene="rain-delay" code={offline ? 'Offline' : 'Unavailable'} quip="Rain delay." title={offline ? 'You are offline' : 'Golf did not answer'} level={level} detail={errorMessage(error)} error={error}
    actions={<>{retryButton(retry, true)}<a className="button secondary" href="/status">Golf status</a></>}>
    {offline ? 'Your browser has no network connection. Reconnect, then try again.' : 'Golf is busy, restarting or out of reach. Try again in a moment, or check its status.'}
  </ErrorScreen>;
}

// The router's last resort: a render or lazy-load failure. Plain links, because the router itself may be the thing that broke.
export function CrashScreen({ error }: { error: unknown }) {
  const detail = error instanceof Error ? errorMessage(error) : '';
  return <main className="page-stack" id="main-content"><ErrorScreen scene="mulligan" code="Error" quip="Mulligan?" title="Golf could not load this page." level={1} detail={detail} error={error}
    actions={<><button type="button" className="button primary" onClick={() => window.location.reload()}><RefreshCw size={15} aria-hidden="true" />Reload Golf</button><a className="button secondary" href="/">Back to repositories</a><a className="button secondary" href="/status">Golf status</a></>}>
    Something went wrong on our side. Reload to check your sign-in and fetch the current version of Golf.
  </ErrorScreen></main>;
}

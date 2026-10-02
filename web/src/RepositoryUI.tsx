import { ArrowDown, LoaderCircle, RefreshCw } from 'lucide-react';
import type { PageResponse } from './gen/golf/v1/golf_pb';
import { errorMessage } from './api';

// Private panels revalidate on mount, discard inactive content, and hide data while revalidating.
export const privateQuery = { staleTime: 0, gcTime: 0 };
export const nextPage = (response: { page?: PageResponse }) => response.page?.nextPage || undefined;
export const shortSHA = (value: string) => value.slice(0, 12);

export function Loading({ label }: { label: string }) {
  return <div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />{label}</div>;
}
export function PanelError({ error, retry }: { error: Error; retry: () => void }) {
  return <div className="panel-error"><p className="error" role="alert">{errorMessage(error)}</p><button type="button" className="button secondary" onClick={retry}><RefreshCw size={15} />Try again</button></div>;
}
export function DateLabel({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? <span>Date unavailable</span> : <time dateTime={value} title={date.toLocaleString()}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>;
}
export function More({ hasMore, loading, load, label }: { hasMore: boolean; loading: boolean; load: () => void; label: string }) {
  return hasMore ? <button className="text-button" disabled={loading} onClick={load}>{loading ? 'Loading…' : `Load more ${label}`}<ArrowDown size={14} /></button> : null;
}

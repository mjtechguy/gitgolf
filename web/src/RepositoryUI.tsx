import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { ArrowDown, Check, Copy, LoaderCircle, RefreshCw } from 'lucide-react';
import type { PageResponse } from './gen/golf/v1/golf_pb';
import { errorMessage } from './api';

// Private panels revalidate on mount, discard inactive content, and hide data while revalidating.
export const privateQuery = { staleTime: 0, gcTime: 0 };
export const nextPage = (response: { page?: PageResponse }) => response.page?.nextPage || undefined;
export const shortSHA = (value: string) => value.slice(0, 12);

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; generation.current++; setStatus(''); return () => { mounted.current = false; generation.current++; }; }, [text]);
  async function copy() {
    const stamp = generation.current;
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current && stamp === generation.current) setStatus('Copied.');
    } catch {
      if (mounted.current && stamp === generation.current) setStatus('Copy unavailable. Select the text and copy it manually.');
    }
  }
  return <span className="copy-action"><button type="button" className="icon-button" aria-label={label} title={label} onClick={() => void copy()}>{status === 'Copied.' ? <Check size={15} aria-hidden="true"/> : <Copy size={15} aria-hidden="true"/>}</button><span className="sr-only" role="status">{status}</span></span>;
}

// Native disclosures retain ordinary tab order; Escape returns to the trigger.
export const disclosureDismiss = {
  onKeyDown: (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); event.stopPropagation(); }
  },
  onBlur: (event: FocusEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  },
};

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

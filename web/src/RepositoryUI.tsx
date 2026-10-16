import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { ArrowDown, Check, Copy, Globe, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import type { PageResponse } from './gen/golf/v1/golf_pb';
import { errorMessage } from './api';

export function RepositoryVisibility({ isPrivate }: { isPrivate: boolean }) {
  const Icon = isPrivate ? LockKeyhole : Globe;
  return <span className={`visibility ${isPrivate ? 'private' : ''}`}><Icon size={12} aria-hidden="true" />{isPrivate ? 'Private' : 'Public'}</span>;
}

// Private panels revalidate on mount, discard inactive content, and hide data while revalidating.
export const privateQuery = { staleTime: 0, gcTime: 0 };
// A read that answered with an error has no data, so it always counts as stale and returning to the tab refetched it,
// swapping the error screen for the loading state on every visibility change. An error stays until Try again or navigation.
export const holdErrorOnFocus = { refetchOnWindowFocus: (query: { state: { status: string } }) => query.state.status !== 'error' };
// Exact immutable observations remain in memory only while mounted. The enclosing
// repository/session gate still revalidates authority and hides on denial.
export const privateSnapshotQuery = { ...privateQuery, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false };
// Retained immutable source is mounted only after a fresh repository access receipt.
export const privateNavigationQuery = { ...privateSnapshotQuery, gcTime: 600_000, meta: { privateNavigation: true } };
export function usePageVisible() {
  return useSyncExternalStore(update => {
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, () => document.visibilityState !== 'hidden', () => false);
}
export const nextPage = (response: { page?: PageResponse }) => response.page?.nextPage || undefined;
export const shortSHA = (value: string) => value.slice(0, 12);

function fragmentSubscription(update:()=>void) {
 window.addEventListener('hashchange',update);window.addEventListener('popstate',update);
 return ()=>{window.removeEventListener('hashchange',update);window.removeEventListener('popstate',update);};
}
export const useFragment=()=>useSyncExternalStore(fragmentSubscription,()=>window.location.hash,()=>'');

export function downloadText(text:string,name:string) {
 const url=URL.createObjectURL(new Blob([text],{type:'application/octet-stream'}));
 const link=document.createElement('a');link.href=url;link.download=name;link.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function fitDisclosure(menu:HTMLDetailsElement,selector:string) {
 menu.classList.remove('opens-up');
 const popup=menu.querySelector<HTMLElement>(selector);
  if(!menu.open||!popup)return;
  popup.style.removeProperty('--disclosure-shift');
  const bounds=popup.getBoundingClientRect();
  popup.style.setProperty('--disclosure-shift',`${Math.max(8-bounds.left,Math.min(0,innerWidth-8-bounds.right))}px`);
  if(bounds.bottom>innerHeight&&menu.getBoundingClientRect().top>=popup.offsetHeight)menu.classList.add('opens-up');
}

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
    if (event.currentTarget.contains(event.relatedTarget)) return;
    // A control that disables itself (Load more → Loading…) drops focus to nowhere; that is not leaving the disclosure.
    const lost = event.target as HTMLElement & { disabled?: boolean };
    if (!event.relatedTarget && (lost.disabled || !lost.isConnected)) { event.currentTarget.querySelector('summary')?.focus(); return; }
    event.currentTarget.open = false;
  },
};

export function Loading({ label }: { label: string }) {
  return <div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />{label}</div>;
}
export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div><h2>{title}</h2><p>{description}</p></div>{actions}</header>;
}
export function PanelError({ error, retry }: { error: Error; retry: () => void }) {
  return <div className="panel-error"><p className="error" role="alert">{errorMessage(error)}</p><button type="button" className="button secondary" onClick={retry}><RefreshCw size={15} />Try again</button></div>;
}
const relativeDateUnits: [Intl.RelativeTimeFormatUnit, number][] = [['year', 365 * 86400], ['month', 30 * 86400], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
const relativeDateFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
export function DateLabel({ value, relative = false }: { value: string; relative?: boolean }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>Date unavailable</span>;
  let label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (relative) {
    const seconds = (date.getTime() - Date.now()) / 1000, age = Math.abs(seconds);
    const [unit, size] = relativeDateUnits.find(([, size]) => age >= size) || relativeDateUnits[relativeDateUnits.length - 1]!;
    label = age < 5 ? seconds > 0 ? 'in a moment' : 'just now' : relativeDateFormat.format(Math.floor(age / size) * Math.sign(seconds), unit);
  }
  return <time dateTime={value} title={date.toLocaleString()}>{label}</time>;
}
export function More({ hasMore, loading, load, label }: { hasMore: boolean; loading: boolean; load: () => void; label: string }) {
  return hasMore ? <button className="text-button" disabled={loading} onClick={load}>{loading ? 'Loading…' : `Load more ${label}`}<ArrowDown size={14} /></button> : null;
}

// Repository and PR workspaces share active-tab reveal and keyboard behavior.
export function RepositoryTabs({label,selection,children,className=''}:{label:string;selection:string;children:ReactNode;className?:string}) {
 const tabs=useRef<HTMLElement>(null);
 useEffect(()=>{
  const nav=tabs.current;if(!nav)return;
  const reveal=()=>{const focused=nav.querySelector<HTMLElement>(':focus-visible');const active=focused||nav.querySelector<HTMLElement>('[aria-current="page"]');if(active&&nav.scrollWidth>nav.clientWidth)nav.scrollLeft=active.offsetLeft-nav.offsetLeft-(nav.clientWidth-active.offsetWidth)/2;};
  reveal();const resize=new ResizeObserver(reveal);resize.observe(nav);const active=nav.querySelector<HTMLElement>('[aria-current="page"]');if(active)resize.observe(active);
  return()=>resize.disconnect();
 },[selection]);
 return <nav ref={tabs} className={`repository-tabs ${className}`} aria-label={label} onFocus={event=>{if(event.target.matches(':focus-visible')){const nav=event.currentTarget;nav.scrollLeft=event.target.offsetLeft-nav.offsetLeft-(nav.clientWidth-event.target.offsetWidth)/2;}}}>{children}</nav>;
}

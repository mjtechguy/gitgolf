import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

// Rail and sidebar layouts lift the repository heading into the top bar and, where the layout asks, its sections into the side navigation.
// The shell's slots live outside React state, so mounting them never re-renders the workspace or its open page.
type Slot = 'heading' | 'navigation' | 'tabs' | 'tools' | 'finder';
const slots: Record<Slot, HTMLElement | null> = { heading: null, navigation: null, tabs: null, tools: null, finder: null };
const slotListeners = new Set<() => void>();
const slotRef = (name: Slot) => (element: HTMLElement | null) => { slots[name] = element; slotListeners.forEach(listener => listener()); };
export const headingSlot = slotRef('heading'), navigationSlot = slotRef('navigation'), tabsSlot = slotRef('tabs'), toolsSlot = slotRef('tools'), finderSlot = slotRef('finder');
export const useShellSlot = (name: Slot) => useSyncExternalStore(callback => { slotListeners.add(callback); return () => slotListeners.delete(callback); }, () => slots[name]);

// Side navigation exists only where the shell shows its rail or sidebar.
const wide = typeof matchMedia === 'function' ? matchMedia('(min-width:1051px)') : undefined;
export const useWideViewport = () => useSyncExternalStore(callback => { wide?.addEventListener('change', callback); return () => wide?.removeEventListener('change', callback); }, () => Boolean(wide?.matches));

// Facts already loaded for the page. Callers pass only values the backend reported.
export function SummaryBand({ label, items }: { label: string; items: [string, ReactNode, string?][] }) {
  return <dl className="summary-band" aria-label={label}>{items.map(([term, value, note]) => <div key={term}><dt>{term}</dt><dd>{value}</dd>{note ? <dd className="summary-band-note">{note}</dd> : null}</div>)}</dl>;
}

const rows = '#main-content :is(.repository-row, .source-tree > li, .commit-list > li, .data-table tbody tr)';
const typing = 'input,textarea,select,[contenteditable="true"],.xterm';
type Shortcut = { keys: string; label: string };

// Sections opt in with data-shortcut; "g" then that letter follows the link.
export function KeyboardLayer() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sections, setSections] = useState<Shortcut[]>([]);
  useEffect(() => {
    let leader = 0;
    const press = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || document.querySelector('dialog[open]') || event.target instanceof Element && event.target.closest(typing)) return;
      const pending = performance.now() - leader < 1500; leader = 0;
      if (pending && /^[a-z]$/.test(event.key)) { const link = document.querySelector<HTMLElement>(`[data-shortcut="${event.key}"]`); if (link) { event.preventDefault(); link.click(); } return; }
      if (event.key === 'g') { leader = performance.now(); return; }
      if (event.key === '?') {
        const seen = new Map<string, string>();
        for (const link of document.querySelectorAll<HTMLElement>('[data-shortcut]')) if (!seen.has(link.dataset.shortcut!)) seen.set(link.dataset.shortcut!, link.textContent?.trim() || link.getAttribute('aria-label') || '');
        setSections([...seen].map(([key, label]) => ({ keys: `g ${key}`, label }))); event.preventDefault(); dialog.current?.showModal(); return;
      }
      if (event.key === '/') { const search = document.querySelector<HTMLElement>('#main-content :is(input[type=search], .search-input input)'); if (search) { event.preventDefault(); search.focus(); } return; }
      if (event.key !== 'j' && event.key !== 'k') return;
      const links = [...document.querySelectorAll(rows)].map(row => row.querySelector<HTMLElement>('a[href]')).filter((link): link is HTMLElement => Boolean(link?.offsetParent));
      if (!links.length) return;
      const current = links.indexOf(document.activeElement as HTMLElement);
      event.preventDefault(); links[Math.max(0, Math.min(links.length - 1, current < 0 ? 0 : current + (event.key === 'j' ? 1 : -1)))]!.focus();
    };
    document.addEventListener('keydown', press);
    return () => document.removeEventListener('keydown', press);
  }, []);
  const key = (keys: string) => keys.split(' ').map(part => <kbd key={part}>{part}</kbd>);
  const general: Shortcut[] = [{ keys: 'j k', label: 'Move through rows' }, { keys: 'Enter', label: 'Open the focused row' }, { keys: '/', label: 'Search this page' }, { keys: 't', label: 'Find a file in a repository' }, { keys: '?', label: 'Show shortcuts' }];
  return <>
    <footer className="shortcut-legend" aria-label="Keyboard shortcuts"><span>{key('g')} then a letter to change section</span><span>{key('j k')} move</span><span>{key('Enter')} open</span><span>{key('/')} search</span><span>{key('?')} all shortcuts</span></footer>
    <dialog ref={dialog} className="create-dialog shortcut-dialog" aria-labelledby="shortcut-title"><div className="dialog-header"><h2 id="shortcut-title">Keyboard shortcuts</h2></div>
      <dl>{[...general, ...sections].map(shortcut => <div key={shortcut.keys}><dt>{key(shortcut.keys)}</dt><dd>{shortcut.label}</dd></div>)}</dl>
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => dialog.current?.close()}>Close</button></div>
    </dialog>
  </>;
}

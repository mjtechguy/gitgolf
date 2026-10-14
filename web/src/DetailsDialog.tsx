import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function DetailsDialog({ title, children, onClose, closeLabel = 'Close details' }: { title: string; children: ReactNode; onClose: () => void; closeLabel?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Keep the original trigger through React StrictMode effect replay.
    previous.current ||= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); close.current?.focus();
    return () => { if (previous.current?.isConnected) previous.current.focus(); };
  }, []);
  return <dialog ref={dialog} className="create-dialog details-dialog" aria-labelledby={titleId} onClose={onClose}>
    <div className="dialog-header"><h2 id={titleId}>{title}</h2><button ref={close} className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><X size={20} aria-hidden="true" /></button></div>
    <div className="page-stack">{children}</div>
  </dialog>;
}

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function DetailsDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); close.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="create-dialog details-dialog" aria-labelledby={titleId} onClose={onClose}>
    <div className="dialog-header"><h2 id={titleId}>{title}</h2><button ref={close} className="icon-button" aria-label="Close details" title="Close details" onClick={onClose}><X size={20} aria-hidden="true" /></button></div>
    <div className="page-stack">{children}</div>
  </dialog>;
}

import { focusManager } from '@tanstack/react-query';

// Private panels hide while they revalidate, so returning to the page must not blank it for nothing. A connected repository live stream
// already reports every change and rechecks access every few seconds; a page that had one only revalidates after an absence of 30 s.
let streams = 0;
export function liveStreamConnected() {
  streams++; let open = true;
  return () => { if (open) { open = false; streams--; } };
}
export function installFocusPolicy(longAbsence = 30_000) {
  focusManager.setEventListener(handleFocus => {
    let hiddenAt = 0, liveWhenHidden = false;
    const changed = () => {
      // The stream stops while hidden, so whether it covered this page is decided when the page was hidden.
      if (document.visibilityState === 'hidden') { if (!hiddenAt) { hiddenAt = Date.now(); liveWhenHidden = streams > 0; } return; }
      const covered = hiddenAt ? liveWhenHidden && Date.now() - hiddenAt < longAbsence : streams > 0;
      hiddenAt = 0;
      if (!covered) handleFocus();
    };
    window.addEventListener('visibilitychange', changed, false);
    return () => window.removeEventListener('visibilitychange', changed);
  });
}

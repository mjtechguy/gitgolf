export const releasePublicationIntentPrefix = 'golf.release-publication.v1:';

export function clearOtherReleasePublicationIntents(actor?: string) {
  try {
    const keep = actor ? `${releasePublicationIntentPrefix}${actor}:` : '';
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(releasePublicationIntentPrefix) && (!keep || !key.startsWith(keep))) sessionStorage.removeItem(key);
    }
  } catch { /* Publication admission separately requires writable tab storage. */ }
}

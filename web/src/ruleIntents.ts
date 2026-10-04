// Cleanup is independent of the lazily loaded rules editor.
export function clearOtherRuleIntents(userId?: string) {
 try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('golf.rule-operation.') && (!userId || !key.startsWith(`golf.rule-operation.${userId}.`))) sessionStorage.removeItem(key); } catch { /* A failed read cannot authorize a new operation. */ }
}

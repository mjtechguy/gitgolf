// Mirrors cloudflare/forge/src/vault.mjs and engines.mjs (docs/CREDENTIAL_VAULT.md, docs/ENGINES.md). No value ever arrives here.
export type CredentialTarget = { scope: 'user' } | { scope: 'organization'; organization: string } | { scope: 'installation' };
export type EngineTarget = CredentialTarget | { scope: 'repository'; repository: { owner: string; name: string }; repositoryId: string };
export type Place = 'cloud' | 'agent-host' | 'ssh-host';
export type CredentialGrant = { id: string; granteeKind: 'user' | 'organization' | 'repository' | 'installation'; granteeId: string; grantee: string; engines: string[]; places: Place[]; createdAt: string };
export type Credential = { id: string; scope: 'user' | 'organization' | 'installation'; ownerId: string; kind: 'api-key' | 'subscription'; provider: string; tool: string; label: string;
  fingerprint: string; valueBytes: number; state: 'active' | 'revoked'; version: number; createdBy: string; createdAt: string; rotatedAt: string; revokedAt: string; lastUsedAt: string;
  usable: boolean; usableReason: string; grants?: CredentialGrant[] };
export type CredentialInventory = { scope: { scope: string; ownerId: string; label: string }; credentials: Credential[]; sharedWithYou: Credential[]; canManage: boolean; ready: boolean; reason: string;
  providers: { id: string; label: string }[]; tools: { id: string; label: string; providers: string[] }[]; places: Place[]; subscriptionTerms: string; limit: number };
export type Engine = { id: string; name: string; kind: 'cloudflare-model' | 'provider-model' | 'coding-cli'; provider: string; model: string; tool: string; places: Place[]; scope: string; ownerId: string;
  credential: { id: string; label: string; kind: string; state: string } | null; enabled: boolean; builtIn: boolean; version: number };
export type EngineUse = { use: string; label: string; detail?: string; selectable: boolean; reason?: string; allowedHere?: boolean;
  selection?: { engineId: string; allowOverride: boolean; version: number; updatedAt: string };
  effective?: { engineId: string; engineName: string; kind: string; model: string; source: string; note: string; refusal: string } };
export type EngineInventory = { scope: { scope: string; scopeId?: string; label: string }; engines: Engine[]; builtIn?: Engine[]; uses: EngineUse[]; selectable: Engine[]; canManage: boolean; canSelect: boolean;
  credentials: Credential[]; kinds: Engine['kind'][]; providers: { id: string; label: string }[]; tools: { id: string; label: string; signIn: string }[]; places: Place[]; workersAiModels: string[]; gateway: boolean };

export const providerLabel = (id: string) => ({ openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', google: 'Google', 'workers-ai': 'Workers AI' } as Record<string, string>)[id] || id;
export const kindLabels: Record<Engine['kind'], string> = { 'cloudflare-model': 'Cloudflare model', 'provider-model': 'Provider model', 'coding-cli': 'Coding CLI' };
export const placeLabels: Record<Place, string> = { cloud: 'Cloud', 'agent-host': 'Agent hosts', 'ssh-host': 'SSH hosts' };
export const sourceLabels: Record<string, string> = { default: 'AI models default', fixed: 'Fixed', installation: 'Installation', organization: 'Organization', repository: 'This repository', explicit: 'Chosen', refused: 'Refused' };
export const credentialMessage = (error: unknown) => error instanceof Error ? error.message : 'The credential operation could not be confirmed. Refresh before trying again.';
export const targetBody = (target: EngineTarget) => target.scope === 'organization' ? { scope: target.scope, organization: target.organization }
  : target.scope === 'repository' ? { scope: target.scope, repository: target.repository, repositoryId: target.repositoryId } : { scope: target.scope };
export const grantText = (grants?: CredentialGrant[]) => !grants?.length ? 'Owner only' : grants.map(grant => grant.grantee).join(', ');

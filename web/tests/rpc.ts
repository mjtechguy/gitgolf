import { ListRepositoryInvitationsRequestSchema, ListRepositoryInvitationsResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { GetOwnEmailNotificationsResponseSchema,GetRepositoryEmailSubscriptionResponseSchema,ListOwnEmailDeliveriesResponseSchema, ResolveRepositorySourceRequestSchema, ResolveRepositorySourceResponseSchema, RepositorySourceResolution, RepositorySourceRefKind, ListAgentTasksResponseSchema, GetAgentUsageRequestSchema, GetAgentUsageResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { create, fromJson, toJson } from '@bufbuild/protobuf';
import type { DescMessage, MessageInitShape } from '@bufbuild/protobuf';
import type { Route } from '@playwright/test';

// Fixtures use the same generated descriptors as the browser, including presence and uint64 rules.
export function respond<Schema extends DescMessage>(route: Route, schema: Schema, message: MessageInitShape<Schema>) {
  return route.fulfill({ status: 200, contentType: 'application/json', json: toJson(schema, create(schema, message)) });
}
export function request<Schema extends DescMessage>(route: Route, schema: Schema) {
  return fromJson(schema, route.request().postDataJSON());
}
export function reject(route: Route, code: 'unauthenticated' | 'permission_denied' | 'not_found' | 'already_exists' | 'failed_precondition' | 'resource_exhausted' | 'unavailable' | 'unimplemented', message: string) {
  // Existing unary fixtures deliberately do not implement the new live method.
  // Keep resource denials distinct from an absent fixture procedure.
  if (code === 'not_found' && route.request().url().endsWith('/WatchRepository')) code = 'unimplemented';
  const status = { unauthenticated: 401, permission_denied: 403, not_found: 404, already_exists: 409, failed_precondition: 400, resource_exhausted: 429, unavailable: 503, unimplemented: 501 }[code];
  return route.fulfill({ status, contentType: 'application/json', json: { code, message } });
}

export function disabledAgentUsage(route: Route) {
 const input=request(route,GetAgentUsageRequestSchema);
 const config={timeoutSeconds:600,tokenBudget:64000,spendLimitCents:1000,maxConcurrent:1};
 return respond(route,GetAgentUsageResponseSchema,{settings:{scope:input.scope,scopeId:'fixture-scope',revision:'0',authorityRevision:'fixture-authority',canEdit:true,config,effective:config,blockedReasons:['Managed task executor is not available.']}});
}

export function disabledAgentTasks(route:Route){return respond(route,ListAgentTasksResponseSchema,{reason:"Managed worker is not connected."});}

// Explicit native fixture inventories; never inferred from the requested ID/ref.
export function resolveSourceFixture(route: Route, repositoryId: string, repository: { owner: string; name: string }, defaultBranch: string, branches: Record<string, string>, tags: Record<string, string> = {}, tagObjects: Record<string,string> = {}) {
  const input = request(route, ResolveRepositorySourceRequestSchema);
  if (input.repositoryId !== repositoryId || input.repository?.owner !== repository.owner || input.repository.name !== repository.name) return reject(route, 'failed_precondition', 'Source fixture target changed.');
  if (input.suffix) {
    const candidates = [RepositorySourceRefKind.BRANCH,RepositorySourceRefKind.TAG].flatMap(kind=>Object.entries(kind===RepositorySourceRefKind.BRANCH?branches:tags).filter(([name])=>input.suffix===name||input.suffix.startsWith(`${name}/`)).map(([name,commitId])=>({selection:{kind,name,commitId,tagObjectId:kind===RepositorySourceRefKind.TAG?tagObjects[name]||commitId:undefined},path:input.suffix===name?'':input.suffix.slice(name.length+1)})));
    if(!candidates.length)return reject(route,'not_found','Exact fixture suffix not found.');
    return respond(route,ResolveRepositorySourceResponseSchema,{repositoryId,repository,suffix:input.suffix,candidates,resolution:candidates.length===1?RepositorySourceResolution.RESOLVED:RepositorySourceResolution.AMBIGUOUS,selection:candidates.length===1?candidates[0]!.selection:undefined,path:candidates.length===1?candidates[0]!.path:''});
  }
  const kind = input.selector?.kind;
  const name = kind === RepositorySourceRefKind.DEFAULT_BRANCH ? defaultBranch : input.selector?.name || '';
  const commitId = kind === RepositorySourceRefKind.DEFAULT_BRANCH || kind === RepositorySourceRefKind.BRANCH ? branches[name] : kind === RepositorySourceRefKind.TAG ? tags[name] : kind === RepositorySourceRefKind.COMMIT ? name : undefined;
  if (!commitId) return reject(route, 'not_found', 'Exact fixture ref not found.');
  return respond(route, ResolveRepositorySourceResponseSchema, { repositoryId, repository, resolution: RepositorySourceResolution.RESOLVED, path: input.path, selection: { kind, name, commitId, tagObjectId:kind===RepositorySourceRefKind.TAG?tagObjects[name]||commitId:undefined } });
}


// Existing account/settings fixtures explicitly observe an unconfigured mail
// consumer. These are browser-fixture receipts, never product capability mocks.
export function unconfiguredOwnEmail(route: Route,nativeUserId:string) {
 return respond(route,GetOwnEmailNotificationsResponseSchema,{state:{userId:nativeUserId,nativeUserId,localAccountId:'1',credentialVersion:'1',loginEmail:'',contactVersion:'0',preferenceVersion:'0',verified:false,enabled:false,transportActive:false}});
}
export function unconfiguredRepositoryEmail(route: Route,nativeUserId:string,target:{repository:{owner:string;name:string};repositoryId:string;ownerId:string}) {
 return respond(route,GetRepositoryEmailSubscriptionResponseSchema,{target,state:{userId:nativeUserId,nativeUserId,localAccountId:'1',credentialVersion:'1',loginEmail:'',contactVersion:'0',preferenceVersion:'0',verified:false,enabled:false,transportActive:false}});
}
export function emptyOwnEmailHistory(route: Route,nativeUserId:string,target?:{repository:{owner:string;name:string};repositoryId:string;ownerId:string}) {return respond(route,ListOwnEmailDeliveriesResponseSchema,{userId:nativeUserId,target,page:{nextPage:0}});}

export function emptyRepositoryInvitations(route: Route) {
 const input=request(route,ListRepositoryInvitationsRequestSchema);
 return respond(route,ListRepositoryInvitationsResponseSchema,{repositoryId:input.repositoryId,ownerId:input.ownerId,accessRevision:input.expectedRevision,canManage:false,localIssuerAvailable:false,invitations:[],page:{nextPage:0}});
}

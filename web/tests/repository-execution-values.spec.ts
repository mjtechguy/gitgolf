import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema,GetSessionResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryAccessResponseSchema, ListRepositoryExecutionValuesResponseSchema, SaveRepositoryExecutionValueRequestSchema, GetRepositoryExecutionValueOperationRequestSchema, RepositoryExecutionValueKind as Kind, type RepositoryExecutionValue } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

// This mounts the actual new component/Connect client in a test-only host. The
// product route/API registration is a separate parent-owned integration proof.
const host = resolve(import.meta.dirname, '../.tmp/execution-values-fixture.html');
test.beforeAll(async () => { await mkdir(resolve(import.meta.dirname, '../.tmp'), { recursive: true }); await writeFile(host, `<!doctype html><html><body><main id="root"></main><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {createClient} from '@connectrpc/connect';import {createConnectTransport} from '@connectrpc/connect-web';import {RepositoryExecutionValueService} from '/src/gen/golf/v1/golf_pb.ts';import {RepositoryExecutionValues} from '/src/RepositoryExecutionValues.tsx';import '/src/styles.css';const client=createClient(RepositoryExecutionValueService,createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false}));createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(RepositoryExecutionValues,{client,userId:'42',owner:'alice',name:'example',signingOut:false})));
</script></body></html>`, { flag: 'wx' }); });
test.afterAll(async () => { await rm(host, { force: true }); });
const target = { repository: { owner: 'alice', name: 'example' }, repositoryId: '9007199254740993', ownerId: '42', accessRevision: 'a'.repeat(64) };
const date = '2026-10-04T12:00:00Z';
async function backend(page: Page) {
 const state = { rows: [] as RepositoryExecutionValue[], revision: '0', drop: false, none: false, denied: false, writes: [] as ReturnType<typeof create<typeof SaveRepositoryExecutionValueRequestSchema>>[], inspections: [] as string[], receipt: undefined as Record<string, unknown> | undefined, delayed: undefined as Promise<void> | undefined };
 await page.route('**/rpc/**', async route => {
  const method = route.request().url().split('/').at(-1);
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:{id:'42',login:'alice'}});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{});
  if (method === 'GetRepositoryAccess') { if(state.denied)return reject(route,'permission_denied','Current repository permission denied.'); return respond(route,GetRepositoryAccessResponseSchema,{access:{repositoryId:target.repositoryId,ownerId:target.ownerId,currentPermission:'owner',canManage:true,revision:target.accessRevision}}); }
  if (method === 'ListRepositoryExecutionValues') { if(state.denied)return reject(route,'permission_denied','Current repository permission denied.'); if(state.delayed)await state.delayed;return respond(route,ListRepositoryExecutionValuesResponseSchema,{target,brokerRevision:state.revision,values:state.rows,maximumValues:64,maximumBindings:20,consumerProfile:'golf.repository-env.v1'}); }
  if (method === 'SaveRepositoryExecutionValue') {
   const input=request(route,SaveRepositoryExecutionValueRequestSchema);state.writes.push(input);expect(input.target?.repositoryId).toBe(target.repositoryId);expect(input.target?.ownerId).toBe('42');
   if(state.none)return route.fulfill({status:400,contentType:'application/json',headers:{'Golf-Execution-Effect':'none'},json:{code:'invalid_argument',message:'Known refused before commit.'}});
   state.revision=(BigInt(state.revision)+1n).toString();const version=(BigInt(input.expectedVersion)+1n).toString();state.rows=[{...createValue(input.id,input.name,input.kind,version)},...state.rows.filter(v=>v.id!==input.id)];state.receipt={target,operationId:input.operationId,action:'save_value',itemId:input.id,acceptedVersion:version,acceptedBrokerRevision:state.revision,committedAt:date};
   if(state.drop)return route.abort('failed');return route.fulfill({status:200,contentType:'application/json',json:{operation:state.receipt}});
  }
  if(method==='GetRepositoryExecutionValueOperation'){const input=request(route,GetRepositoryExecutionValueOperationRequestSchema);state.inspections.push(input.operationId);if(!state.receipt)return reject(route,'not_found','Original operation remains unconfirmed.');return route.fulfill({status:200,contentType:'application/json',json:{operation:state.receipt}});}
  return reject(route,'unimplemented','No fixture procedure.');
 });return state;
}
function createValue(id:string,name:string,kind:Kind,version='1'){return {id,name,kind,version,deleted:false,createdAt:date,updatedAt:date} as RepositoryExecutionValue;}
async function open(page:Page){await page.goto('/.tmp/execution-values-fixture.html');await expect(page.getByRole('table',{name:'Repository secrets and variables',exact:true})).toBeVisible();}
async function newValue(page:Page,name='BUILD_CREDENTIAL',value='private-fixture-secret'){await page.getByRole('button',{name:'Add value',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill(name);await page.getByLabel('Value',{exact:true}).fill(value);}

test('inventory opens explicit editor, switches value type and never exposes secret readback',async({page})=>{
 const state=await backend(page);state.rows=[createValue('10000000-0000-4000-8000-000000000001','BUILD_CREDENTIAL',Kind.SECRET)];state.revision='1';await open(page);await expect(page.getByRole('form')).toHaveCount(0);await page.getByRole('button',{name:'Replace secret BUILD_CREDENTIAL',exact:true}).click();await expect(page.getByLabel('Replacement secret',{exact:true})).toHaveAttribute('type','password');await expect(page.getByLabel('Replacement secret',{exact:true})).toHaveValue('');await page.getByRole('button',{name:'Cancel',exact:true}).click();await newValue(page,'BUILD_REGION','ordinary');await page.getByLabel('Type',{exact:true}).selectOption(String(Kind.VARIABLE));await expect(page.getByLabel('Value',{exact:true})).toHaveAttribute('type','text');await page.getByRole('button',{name:'Save value',exact:true}).click();await expect(page.getByRole('table',{name:'Repository secrets and variables',exact:true}).getByText('BUILD_REGION',{exact:true})).toBeVisible();expect(state.writes).toHaveLength(1);expect(state.writes[0]!.expectedBrokerRevision).toBe('1');
});
test('lost acknowledgement reload keeps only bounded operation metadata and inspects without repeating a write',async({page})=>{
 const state=await backend(page);state.drop=true;await open(page);await newValue(page);await page.getByRole('button',{name:'Save value',exact:true}).click();await expect(page.getByRole('button',{name:'Check operation status',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Add value',exact:true})).toBeDisabled();const stored=await page.evaluate(()=>Object.values(sessionStorage).join(''));expect(stored).not.toContain('private-fixture-secret');expect(stored).not.toContain('BUILD_CREDENTIAL');expect(stored).toContain(state.writes[0]!.operationId);await page.reload();await expect(page.getByRole('button',{name:'Check operation status',exact:true})).toBeVisible();expect(state.writes).toHaveLength(1);await page.getByRole('button',{name:'Check operation status',exact:true}).click();await expect(page.getByText('Recorded change confirmed.',{exact:true})).toBeVisible();expect(state.inspections).toEqual([state.writes[0]!.operationId]);await expect(page.getByRole('button',{name:'Add value',exact:true})).toBeEnabled();expect(await page.evaluate(()=>Object.values(sessionStorage))).toEqual([]);
});
test('known precommit refusal permits explicit correction while unknown status does not',async({page})=>{
 const state=await backend(page);state.none=true;await open(page);await newValue(page);await page.getByRole('button',{name:'Save value',exact:true}).click();await expect(page.getByText('The change was refused before commit. Refresh current values and review the request before an explicit new attempt.',{exact:true})).toBeVisible();await expect(page.getByRole('form',{name:'Repository execution value editor'})).toBeVisible();expect(await page.evaluate(()=>Object.values(sessionStorage))).toEqual([]);state.none=false;state.drop=true;await page.getByRole('button',{name:'Save value',exact:true}).click();await expect(page.getByRole('button',{name:'Check operation status',exact:true})).toBeVisible();state.receipt=undefined;await page.getByRole('button',{name:'Check operation status',exact:true}).click();await expect(page.getByRole('button',{name:'Add value',exact:true})).toBeDisabled();expect(state.writes).toHaveLength(2);
});
test('private editor and prior inventory disappear on native permission loss',async({page})=>{
 const state=await backend(page);state.rows=[createValue('10000000-0000-4000-8000-000000000001','BUILD_CREDENTIAL',Kind.SECRET)];await open(page);await newValue(page);state.denied=true;await page.getByRole('button',{name:'Refresh execution values',exact:true}).click();await expect(page.getByRole('form')).toHaveCount(0);await expect(page.getByRole('table')).toHaveCount(0);await expect(page.getByText('BUILD_CREDENTIAL',{exact:true})).toHaveCount(0);
});
for(const width of [390,1440])test(`both inventories use bounded shared tables at${width}`,async({page})=>{await page.setViewportSize({width,height:900});const state=await backend(page);state.rows=[createValue('10000000-0000-4000-8000-000000000001','BUILD_CREDENTIAL',Kind.SECRET),createValue('20000000-0000-4000-8000-000000000002','BUILD_REGION',Kind.VARIABLE)];await open(page);await expect(page.getByRole('searchbox',{name:'Search loaded Repository secrets and variables',exact:true})).toBeVisible();await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.fonts.check('12px Archivo'))).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.getByRole('button',{name:'Add value',exact:true}).click();await expect(page.getByRole('form')).toBeVisible();});


test('product secrets route has one contextual layout and the shared generated client',async({page})=>{
 const state=await backend(page);await page.goto('/alice/example/settings/secrets');
 await expect(page.getByRole('navigation',{name:'Repository settings',exact:true})).toHaveCount(1);
 await expect(page.getByRole('navigation',{name:'Breadcrumb',exact:true})).toContainText('Secrets and variables');
 await expect(page.getByRole('link',{name:'Secrets and variables',exact:true})).toHaveAttribute('data-status','active');
 await expect(page.getByRole('table',{name:'Repository secrets and variables',exact:true})).toBeVisible();
 await newValue(page,'BUILD_REGION','ordinary');await page.getByLabel('Type',{exact:true}).selectOption(String(Kind.VARIABLE));await page.getByRole('button',{name:'Save value',exact:true}).click();
 await expect(page.getByRole('table',{name:'Repository secrets and variables',exact:true})).toContainText('BUILD_REGION');expect(state.writes).toHaveLength(1);
 await page.reload();await expect(page.getByRole('table',{name:'Repository secrets and variables',exact:true})).toContainText('BUILD_REGION');expect(state.writes).toHaveLength(1);
});

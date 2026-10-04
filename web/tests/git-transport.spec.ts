import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GitCredentialMode as Mode, GitCredentialSchema, GetGitTransportResponseSchema, ListGitCredentialsResponseSchema, CreateGitCredentialRequestSchema, CreateGitCredentialResponseSchema, RevokeGitCredentialRequestSchema, RevokeGitCredentialResponseSchema, type GitCredential } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
const secret = `golf_git_${'A'.repeat(43)}`;
const target={repository:{owner:'alice',name:'example'},repositoryId:'123',ownerId:'42'};
const stamp='2026-10-04T00:00:00Z';
const credential=()=>create(GitCredentialSchema,{id:'1',label:'Work laptop',repositoryId:'123',ownerId:'42',mode:Mode.READ,createdAt:stamp,expiresAt:'2026-10-04T01:00:00Z',sourceSessionId:'12',sourceSessionActive:true});
async function backend(page:Page) {
 const state={rows:[] as GitCredential[],create:0,revoke:0,denied:false,enabled:true,lost:false,wrong:false,barrier:undefined as Promise<void>|undefined};
 await page.route('**/rpc/**', async route=>{
  const method=route.request().url().split('/').at(-1);
  if(state.denied)return reject(route,'permission_denied','Current repository authority is required.');
  if(method==='GetGitTransport')return respond(route,GetGitTransportResponseSchema,{...target,enabled:state.enabled,cloneUrl:state.enabled?'https://golf.example/git/alice/example.git':'',readCredentialAvailable:state.enabled,writeNotice:'Fresh private-native write qualification has not been enrolled.'});
  if(method==='ListGitCredentials')return respond(route,ListGitCredentialsResponseSchema,{credentials:state.rows,page:{nextPage:0}});
  if(method==='CreateGitCredential'){
   const input=request(route,CreateGitCredentialRequestSchema);expect(input).toMatchObject({...target,mode:Mode.READ,label:'Work laptop'});state.create++;if(state.barrier)await state.barrier;
   state.rows=[credential()];if(state.lost)return route.abort('failed');
   return respond(route,CreateGitCredentialResponseSchema,{credential:{...state.rows[0]!,repositoryId:state.wrong?'999':'123'},secret});
  }
  expect(method).toBe('RevokeGitCredential');const input=request(route,RevokeGitCredentialRequestSchema);expect(input).toMatchObject({...target,credentialId:'1'});state.revoke++;
  state.rows=[{...credential(),revokedAt:stamp}];return respond(route,RevokeGitCredentialResponseSchema,{credentialId:'1',revoked:true});
 });return state;
}
async function open(page:Page){await page.goto('/tests/fixtures/git-transport.html');await expect(page.getByRole('table',{name:'Golf Git credentials',exact:true})).toBeVisible();}
async function newCredential(page:Page){await page.getByRole('button',{name:'New Git credential',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Work laptop');}
test('inventory precedes forms and unqualified WRITE stays disabled',async({page})=>{await backend(page);await open(page);await expect(page.getByRole('form')).toHaveCount(0);await newCredential(page);await expect(page.getByRole('option',{name:'Write · unprotected Git updates'})).toBeDisabled();await expect(page.getByText('Search and sorting cover loaded entries only.')).toBeVisible();});
test('create returns one secret in memory and dismissal never persists it',async({page})=>{const s=await backend(page);await open(page);await newCredential(page);await page.getByRole('button',{name:'Create Git credential',exact:true}).click();await expect(page.getByLabel('Git credential · username golf')).toHaveValue(secret);expect(s.create).toBe(1);expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain(secret);await page.getByRole('button',{name:'Dismiss secret'}).click();await expect(page.getByLabel('Git credential · username golf')).toHaveCount(0);await page.reload();await expect(page.getByRole('cell',{name:'Work laptop',exact:true})).toBeVisible();await expect(page.getByLabel('Git credential · username golf')).toHaveCount(0);});
for(const mode of ['lost','wrong'] as const)test(`${mode} receipt blocks blind replacement`,async({page})=>{const s=await backend(page);s[mode]=true;await open(page);await newCredential(page);await page.getByRole('button',{name:'Create Git credential',exact:true}).click();await expect(page.getByRole('status')).toContainText('Creation was not confirmed');await expect(page.getByRole('button',{name:'New Git credential',exact:true})).toBeDisabled();await expect(page.getByLabel('Git credential · username golf')).toHaveCount(0);expect(s.create).toBe(1);await page.getByRole('button',{name:'Refresh Git transport and credentials'}).click();await expect(page.getByRole('cell',{name:'Work laptop',exact:true})).toBeVisible();expect(s.create).toBe(1);});
test('revocation requires confirmation and only one exact scoped mutation',async({page})=>{const s=await backend(page);s.rows=[credential()];await open(page);await page.getByRole('button',{name:'Revoke Git credential Work laptop'}).click();expect(s.revoke).toBe(0);await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(s.revoke).toBe(0);await page.getByRole('button',{name:'Revoke Git credential Work laptop'}).click();await page.getByRole('button',{name:'Confirm revoke Git credential',exact:true}).click();await expect(page.getByRole('cell',{name:'Revoked',exact:true})).toBeVisible();expect(s.revoke).toBe(1);});
for(const action of ['Fixture sign out','Fixture switch user','Fixture replace repository'])test(`late secret is fenced after ${action}`,async({page})=>{const s=await backend(page);let release!:()=>void;s.barrier=new Promise<void>(r=>{release=r;});await open(page);await newCredential(page);await page.getByRole('button',{name:'Create Git credential',exact:true}).click();await expect.poll(()=>s.create).toBe(1);s.denied=true;await page.getByRole('button',{name:action,exact:true}).click();release();await expect(page.getByLabel('Git credential · username golf')).toHaveCount(0);await expect(page.getByRole('form')).toHaveCount(0);expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain(secret);});

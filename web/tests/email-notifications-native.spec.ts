import {test,expect,type Page} from '@playwright/test';
import {create} from '@bufbuild/protobuf';
import {request,respond,reject} from './rpc';
import {GetProfileResponseSchema,GetSessionResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryAccessResponseSchema,GetOwnEmailNotificationsResponseSchema,OwnEmailNotificationStateSchema,SaveOwnEmailPreferenceRequestSchema,SaveOwnEmailPreferenceResponseSchema,GetRepositoryEmailSubscriptionResponseSchema,SaveRepositoryEmailSubscriptionRequestSchema,SaveRepositoryEmailSubscriptionResponseSchema,RepositoryEmailSubscriptionSchema,ListOwnEmailDeliveriesResponseSchema,EmailDeliverySchema,RedeliverOwnEmailRequestSchema,RedeliverOwnEmailResponseSchema,ListRepositoryWebhooksResponseSchema,type RepositoryEmailSubscription} from '../src/gen/golf/v1/golf_pb';

// Cloudflare native: the Access sign-in address is the mailbox, there is no local account, SMTP transport or verification code,
// and the provider's acceptance is the only receipt. These fixtures mirror what cloudflare/forge/src/email.mjs returns.
const user={id:'17',login:'alice'};const target={repository:{owner:'alice',name:'example'},repositoryId:'7',ownerId:'1'};const subId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const own=()=>create(OwnEmailNotificationStateSchema,{userId:user.id,nativeUserId:user.id,contactVersion:'1',preferenceVersion:'0',loginEmail:'alice@example.com',verified:true,enabled:false,transportActive:true});
const accepted=()=>create(EmailDeliverySchema,{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',kind:'activity',eventId:'discussion:cccccccc-cccc-4ccc-8ccc-cccccccccccc',eventTopic:'issues',state:'accepted',attempts:1,createdAt:'2026-10-14T10:00:00Z',completedAt:'2026-10-14T10:00:01Z',subscriptionId:subId,subscriptionVersion:'1',contactVersion:'1'});
async function fixture(page:Page,email:1|3|4=4,webhooks:1|3=1){
 const s={state:own(),subscription:undefined as RepositoryEmailSubscription|undefined,deliveries:[accepted()],writes:[] as {method:string;body:unknown}[],reads:[] as string[],invent:'' as ''|'smtp'|'local'};
 await page.route('**/native/config',route=>route.fulfill({status:200,contentType:'application/json',json:{runtimeProfile:'cloudflare-native',workspace:'alice'}}));
 await page.route('**/rpc/**',async route=>{const method=route.request().url().split('/').at(-1)!;s.reads.push(method);
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{runtimeProfile:'cloudflare-native',capabilities:[{id:'repository.email-notifications',label:'Repository email notifications',state:email,reason:'Email to each subscriber\'s own Access sign-in address through Cloudflare Email Service.'},{id:'settings.repository-webhooks',label:'Webhooks',state:webhooks,reason:''}]});
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='GetProfile')return respond(route,GetProfileResponseSchema,{profile:{userId:user.id,login:user.login,revision:'current',canEdit:true}});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{});
  if(method==='GetRepositoryAccess')return respond(route,GetRepositoryAccessResponseSchema,{access:{repositoryId:target.repositoryId,ownerId:target.ownerId,owner:{id:'1',login:'alice'},currentPermission:'read',canManage:false,revision:'current'}});
  if(method==='ListRepositoryWebhooks')return respond(route,ListRepositoryWebhooksResponseSchema,{target,subscriptions:[],page:{nextPage:0}});
  const state=s.invent==='local'?{...s.state,localAccountId:'9',credentialVersion:'3'}:s.state;
  if(method==='GetOwnEmailNotifications')return respond(route,GetOwnEmailNotificationsResponseSchema,{state});
  if(method==='GetRepositoryEmailSubscription')return respond(route,GetRepositoryEmailSubscriptionResponseSchema,{target,subscription:s.subscription,state});
  if(method==='ListOwnEmailDeliveries'){const body=JSON.parse(route.request().postData()||'{}');return respond(route,ListOwnEmailDeliveriesResponseSchema,{userId:user.id,target:body.target,deliveries:body.target?s.deliveries.map(d=>s.invent==='smtp'?{...d,smtpStatus:250}:d):[],page:{nextPage:0}});}
  if(method==='SaveOwnEmailPreference'){const input=request(route,SaveOwnEmailPreferenceRequestSchema);s.writes.push({method,body:input});s.state=create(OwnEmailNotificationStateSchema,{...s.state,enabled:input.enabled,suppression:'',preferenceVersion:(BigInt(input.expectedPreferenceVersion)+1n).toString()});return respond(route,SaveOwnEmailPreferenceResponseSchema,{state:s.state});}
  if(method==='SaveRepositoryEmailSubscription'){const input=request(route,SaveRepositoryEmailSubscriptionRequestSchema);s.writes.push({method,body:input});s.subscription=create(RepositoryEmailSubscriptionSchema,{id:input.id,version:(BigInt(input.expectedVersion)+1n).toString(),contactVersion:input.expectedContactVersion,eventTopics:[...input.eventTopics].sort(),enabled:input.enabled,authorizationState:input.enabled?'authorized':'disabled',updatedAt:'2026-10-14T10:00:00Z',workflowNotifications:input.workflowNotifications});return respond(route,SaveRepositoryEmailSubscriptionResponseSchema,{target,subscription:s.subscription});}
  if(method==='RedeliverOwnEmail'){const input=request(route,RedeliverOwnEmailRequestSchema);s.writes.push({method,body:input});const d=create(EmailDeliverySchema,{...accepted(),id:input.operationId,state:'queued',attempts:0,completedAt:'',possibleDuplicate:true});s.deliveries.unshift(d);return respond(route,RedeliverOwnEmailResponseSchema,{userId:user.id,delivery:d});}
  return reject(route,'unimplemented','This capability is not implemented on the native forge.');});
 return s;}
const ownTable=(page:Page)=>page.getByRole('table',{name:'Notification email settings',exact:true});

test('native account settings show the Access address and Cloudflare delivery, with no SMTP, verification or account history',async({page})=>{
 const s=await fixture(page);await page.goto('/account/settings');
 await expect(ownTable(page)).toContainText('alice@example.com');await expect(ownTable(page)).toContainText('Cloudflare Access sign-in address');await expect(ownTable(page)).toContainText('Cloudflare Email Service');
 await expect(page.getByText('SMTP',{exact:false})).toHaveCount(0);await expect(page.getByRole('button',{name:'Send verification code',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Email delivery history',exact:true})).toHaveCount(0);await expect(page.getByText('each subscription shows its own delivery history',{exact:false})).toBeVisible();
 await expect(page.getByRole('form')).toHaveCount(0);expect(s.writes).toHaveLength(0);expect(s.reads).not.toContain('ListOwnEmailDeliveries');
 // Enabling needs explicit consent and carries the observed versions.
 await page.getByRole('button',{name:'Edit email preference',exact:true}).click();await page.getByLabel('Enable notification email',{exact:true}).check();
 await page.getByRole('button',{name:'Save preference',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Explicitly authorize');expect(s.writes).toHaveLength(0);
 await page.getByLabel('Authorize my repository email subscriptions after browser logout',{exact:true}).check();await page.getByRole('button',{name:'Save preference',exact:true}).click();
 await expect(page.getByRole('form')).toHaveCount(0);await expect(ownTable(page)).toContainText('Enabled');
 expect(s.writes).toEqual([{method:'SaveOwnEmailPreference',body:expect.objectContaining({expectedContactVersion:'1',expectedPreferenceVersion:'0',enabled:true,authorizeBackground:true})}]);
 await page.getByText('Email delivery and privacy',{exact:true}).click();await expect(page.getByText('no titles, bodies, source or logs',{exact:false})).toBeVisible();await expect(page.getByText('Bounces, complaints and replies are not observed.',{exact:false})).toBeVisible();
});

test('a provider-suppressed address can be re-enabled by its owner on native',async({page})=>{
 const s=await fixture(page);s.state=create(OwnEmailNotificationStateSchema,{...own(),preferenceVersion:'2',suppression:'recipient_rejected'});await page.goto('/account/settings');
 await expect(ownTable(page)).toContainText('Paused · provider suppressed this address');await page.getByRole('button',{name:'Edit email preference',exact:true}).click();
 await expect(page.getByText('refused this address as suppressed',{exact:false})).toBeVisible();await page.getByLabel('Enable notification email',{exact:true}).check();
 await page.getByLabel('Authorize my repository email subscriptions after browser logout',{exact:true}).check();await page.getByRole('button',{name:'Save preference',exact:true}).click();
 await expect(ownTable(page)).toContainText('Enabled');expect(s.writes[0]!.body).toMatchObject({expectedPreferenceVersion:'2',enabled:true});
});

test('a disabled native capability mounts no email settings and reads nothing',async({page})=>{
 const s=await fixture(page,1);await page.goto('/account/settings');await expect(page.getByRole('heading',{name:'Profile',exact:true,level:1})).toBeVisible();
 await expect(page.getByText('Installation details',{exact:true})).toBeVisible();await expect(ownTable(page)).toHaveCount(0);expect(s.reads).not.toContain('GetOwnEmailNotifications');
 await page.goto('/alice/example/settings/webhooks');await expect(page.getByRole('table',{name:'My repository email subscription',exact:true})).toHaveCount(0);expect(s.reads).not.toContain('GetRepositoryEmailSubscription');
});

test('native repository email opens without webhooks and shows provider acceptance, never an SMTP status',async({page})=>{
 const s=await fixture(page);s.state=create(OwnEmailNotificationStateSchema,{...own(),preferenceVersion:'1',enabled:true});await page.goto('/alice/example/settings/webhooks');
 await expect(page.getByRole('heading',{name:'Email notifications',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Webhooks',exact:true,level:1})).toHaveCount(0);expect(s.reads).not.toContain('ListRepositoryWebhooks');
 await expect(page.getByRole('navigation',{name:'Repository settings'}).getByRole('link',{name:'Email notifications'})).toBeVisible();
 await page.getByRole('button',{name:'Add subscription',exact:true}).click();await page.getByLabel('Issues',{exact:true}).check();await page.getByLabel('Enable this repository email subscription',{exact:true}).check();
 await page.getByLabel('Authorize background delivery to my Access sign-in address',{exact:true}).check();await page.getByRole('button',{name:'Save subscription',exact:true}).click();
 await expect(page.getByRole('form')).toHaveCount(0);await expect(page.getByRole('table',{name:'My repository email subscription',exact:true})).toContainText('alice@example.com');
 expect(s.writes[0]).toMatchObject({method:'SaveRepositoryEmailSubscription',body:{target,expectedVersion:'0',expectedContactVersion:'1',enabled:true,authorizeBackground:true}});
 const history=page.getByRole('table',{name:'Email deliveries',exact:true});await expect(history).toContainText('Accepted by provider');
 await expect(history.getByRole('columnheader',{name:'SMTP'})).toHaveCount(0);await expect(history).not.toContainText('SMTP');
 await page.getByRole('button',{name:`Redeliver email ${accepted().id}`,exact:true}).click();await expect(page.getByRole('dialog')).toContainText('the provider assigns its Message-ID');
 await page.getByRole('button',{name:'Confirm email redelivery',exact:true}).click();await expect.poll(()=>s.writes.length).toBe(2);
 expect(s.writes[1]!.body).toMatchObject({deliveryId:accepted().id,expectedContactVersion:'1'});await expect(history).toContainText('May duplicate an earlier accepted message');
});

test('native receipts claiming an SMTP status or a local account are refused as incomplete',async({page})=>{
 const s=await fixture(page,3,3);s.state=create(OwnEmailNotificationStateSchema,{...own(),preferenceVersion:'1',enabled:true});s.invent='smtp';await page.goto('/alice/example/settings/webhooks');
 await expect(page.getByRole('heading',{name:'Webhooks',exact:true,level:1})).toBeVisible();
 await expect(page.getByText('Email delivery identity is incomplete.',{exact:false})).toBeVisible();await expect(page.getByRole('table',{name:'Email deliveries',exact:true})).toHaveCount(0);
 s.invent='local';await page.goto('/account/settings');await expect(page.getByText('Notification mailbox metadata is incomplete.',{exact:false})).toBeVisible();await expect(ownTable(page)).toHaveCount(0);
});

for(const theme of ['dark','light'])for(const width of [390,1440])test(`native email ${theme} ${width} has no overflow`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.addInitScript(t=>localStorage.setItem('golf.theme',t),theme);const s=await fixture(page);s.state=create(OwnEmailNotificationStateSchema,{...own(),preferenceVersion:'1',enabled:true});
 await page.goto('/alice/example/settings/webhooks');await page.getByRole('button',{name:'Add subscription',exact:true}).click();await expect(page.getByRole('form',{name:'Repository email subscription editor'})).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(s.writes).toHaveLength(0);
});

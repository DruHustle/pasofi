import {test,expect,type Page,type Route} from '@playwright/test';
import {usageSnapshot} from './usage-fixture';

const staffId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',siteId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',customerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storageKey=`pamofi.operation:staff:${staffId}:sales-location-status`;
const longLocationName='Lawfield Farm customer welcome and cash sales location serving the northern residential community';
const staff={staffId,email:'admin@staff.invalid',displayName:'Test administrator',status:'approved',role:'admin',siteIds:[],version:1,mfaVerified:true,mfaEnrolled:true};
type Location={id:string;name:string;enabled?:boolean;version?:string};
const send=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function setup(page:Page,{capable=true,version='1',role='admin',patch}:{capable?:boolean;version?:string;role?:string;patch?:(route:Route)=>Promise<void>}={}){
 const state={site:{id:siteId,name:'Reviewed sales location',enabled:true,...(version?{version}:{})} as Location,patches:[] as {key:string;body:unknown}[]};
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path===`/api/admin/sites/${siteId}`){state.patches.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});if(patch)return patch(route);return send(route,{error:'unexpected_mutation'},500);}
  if(path==='/api/capabilities')return send(route,{demo:false,paymentMode:'disabled',paymentCheckout:false,vouchers:false,receiptPairing:false,staffSales:false,inventoryAllocation:true,deliverySms:false,networkAccess:false,mobileCookies:false,...(capable?{salesLocationStatus:true}:{})});
  if(path==='/api/staff/session')return send(route,{...staff,role,siteIds:role==='admin'?[]:[siteId]});
  if(path==='/api/staff/users')return send(route,{users:[staff],nextCursor:null});
  if(path==='/api/staff/sites'||path==='/api/sites')return send(route,{sites:[state.site]});
  if(path==='/api/staff/inventory')return send(route,{inventory:[]});
  if(path==='/api/admin/bundles')return send(route,{products:[],currencies:['USD']});
  if(path==='/api/bundles')return send(route,{products:[]});
  if(path==='/api/staff/sales')return send(route,{sales:[],hasMore:false,nextOffset:null});
  if(path==='/api/staff/cash-shifts')return send(route,{shifts:[],currencies:['USD']});
  if(path==='/api/staff/cash-refunds')return send(route,{refunds:[]});
  if(path==='/api/session')return send(route,{customerId});
  if(path==='/api/usage')return send(route,{customerId,...usageSnapshot('0',{allowanceBytes:'0'})});
  if(path==='/api/access')return send(route,{customerId,entitlements:[],hasMore:false,nextOffset:null});
  if(path==='/api/recovery/status')return send(route,{configured:false});
  if(path==='/api/help')return send(route,{articles:[]});
  return send(route,{error:'unavailable'},404);
 });
 return state;
}
async function openSites(page:Page){await page.goto('/');await page.getByRole('button',{name:'Staff',exact:true}).click();await page.getByRole('button',{name:'Sites',exact:true}).click();await expect(page.getByRole('heading',{name:'Sales locations',exact:true})).toBeVisible();}

for(const mode of ['older backend','missing version'] as const)test(`sales location action is hidden for ${mode}`,async({page})=>{
 const state=await setup(page,{capable:mode!=='older backend',version:mode==='missing version'?'':'1'});await openSites(page);
 await expect(page.getByRole('button',{name:'Review sales status for Reviewed sales location'})).toHaveCount(0);
 if(mode==='older backend')await expect(page.getByText('Sales location status controls require the service update.')).toBeVisible();
 expect(state.patches).toHaveLength(0);
});

test('stale sales location review is rejected and a fresh decision uses the current version',async({page},testInfo)=>{
 let attempts=0;
 const state=await setup(page,{patch:async route=>{
  if(++attempts===1){await send(route,{error:'version_conflict'},409);return;}
  state.site={...state.site,enabled:true,version:'3'};await send(route,{site:state.site,changed:true,replayed:false});
 }});
 state.site.name=longLocationName;await page.setViewportSize({width:1280,height:900});
 await openSites(page);await page.getByRole('button',{name:`Review sales status for ${longLocationName}`}).click();
 await expect(page.getByLabel('Sales location reason')).toHaveAccessibleDescription('Enter at least 10 characters explaining this sales location decision.');
 await page.getByLabel('Sales location reason').fill('Pause new sales for the reviewed commissioning window');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('sales-location-review-1280.png'),fullPage:true});
 state.site={...state.site,enabled:false,version:'2'};
 await page.getByRole('button',{name:'Pause new sales',exact:true}).click();await expect(page.getByText('This record changed while you were reviewing it.',{exact:false})).toBeVisible();
 await expect(page.getByText('New sales paused',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Retry saved sales location decision'})).toHaveCount(0);
 await page.getByRole('button',{name:`Review sales status for ${longLocationName}`}).click();await page.getByLabel('Sales location reason').fill('Enable after reviewing the latest sales location state');await page.getByRole('button',{name:'Enable new sales',exact:true}).click();
 await expect(page.getByText('Sales location decision saved.',{exact:false})).toBeVisible();await expect(page.getByText('New sales enabled',{exact:true})).toBeVisible();
 expect(state.patches).toHaveLength(2);expect(state.patches[0].body).toMatchObject({expectedVersion:'1',enabled:false});expect(state.patches[1].body).toMatchObject({expectedVersion:'2',enabled:true});expect(state.patches[0].key).not.toBe(state.patches[1].key);
});

test('lost status response restores its exact key and refreshes a later decision after replay',async({page},testInfo)=>{
 let original:Location|undefined;
 const state=await setup(page,{patch:async route=>{
  if(state.patches.length===1){state.site={...state.site,enabled:false,version:'2'};original={...state.site};await route.abort('failed');}
  else await send(route,{site:original,changed:true,replayed:true});
 }});
 state.site.name=longLocationName;await page.setViewportSize({width:320,height:850});await openSites(page);await page.getByRole('button',{name:`Review sales status for ${longLocationName}`}).click();await page.getByLabel('Sales location reason').fill('Pause new sales while the location is commissioned');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('sales-location-review-320.png'),fullPage:true});
 await page.getByRole('button',{name:'Pause new sales',exact:true}).click();
 await expect(page.getByText('The saved decision remains available;', {exact:false})).toBeVisible();
 state.site={...state.site,enabled:true,version:'3'};
 await page.reload();await page.getByRole('button',{name:'Staff',exact:true}).click();await page.getByRole('button',{name:'Sites',exact:true}).click();
 await expect(page.getByText('Saved decision: pause new sales.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:`Review sales status for ${longLocationName}`})).toBeDisabled();
 await page.getByRole('button',{name:'Retry saved sales location decision'}).click();await expect(page.getByText('Saved sales location decision recovered.',{exact:false})).toBeVisible();await expect(page.getByText('New sales enabled',{exact:true})).toBeVisible();
 expect(state.patches).toHaveLength(2);expect(state.patches[0]).toEqual(state.patches[1]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
});

test('malformed saved JSON blocks writes and requires an explicit local recovery after current status is reviewed',async({page})=>{
 const raw=JSON.stringify({key:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',payload:JSON.stringify({siteId,body:null})});
 await page.addInitScript(({key,value})=>sessionStorage.setItem(key,value),{key:storageKey,value:raw});const state=await setup(page);await openSites(page);
 await expect(page.getByRole('alert')).toContainText('Saved sales location decision details are unreadable');await expect(page.getByRole('button',{name:'Review sales status for Reviewed sales location'})).toBeDisabled();
 expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBe(raw);expect(state.patches).toHaveLength(0);
 const discard=page.getByRole('button',{name:'Discard unreadable local decision after review'});await expect(discard).toBeDisabled();await page.getByRole('button',{name:'Refresh sales locations',exact:true}).click();await expect(discard).toBeEnabled();await discard.click();
 await expect(page.getByText('Unreadable local decision discarded.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Review sales status for Reviewed sales location'})).toBeEnabled();expect(state.patches).toHaveLength(0);expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
});

test('storage denied before a status request sends no mutation and does not claim a saved decision',async({page})=>{
 const state=await setup(page);await openSites(page);await page.getByRole('button',{name:'Review sales status for Reviewed sales location'}).click();await page.getByLabel('Sales location reason').fill('Pause the sales location after the reviewed checks');
 await page.evaluate(key=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(name===key)throw new DOMException('Storage blocked','QuotaExceededError');original.call(this,name,value);};},storageKey);
 await page.getByRole('button',{name:'Pause new sales',exact:true}).click();await expect(page.getByText('The decision could not be saved in this browser, so no change was sent.',{exact:false})).toBeVisible();expect(state.patches).toHaveLength(0);await expect(page.getByRole('button',{name:'Retry saved sales location decision'})).toHaveCount(0);
});

test('an approved agent does not receive sales location administration controls',async({page})=>{
 const state=await setup(page,{role:'agent'});await page.goto('/');await page.getByRole('button',{name:'Staff',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out of staff'})).toBeVisible();await expect(page.getByRole('button',{name:'Sites',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Sales locations',exact:true})).toHaveCount(0);expect(state.patches).toHaveLength(0);
});

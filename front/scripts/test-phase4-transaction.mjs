#!/usr/bin/env node
/** Private fixture stdin; BASE_URL explicit. Caller must always cleanup fixture.
 * Real cash API lifecycle + kitchen/bar DOM + real receipt popup + sales totals.
 * No provider calls, email, physical printing, global settings or existing orders.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import puppeteer from 'puppeteer-core';
let browser, stage='configuration', orderId=null, blocked=0, external=0, errors=0;
let guardProbeActive=false, expectedWriteBlocks=0, expectedExternalBlocks=0, expectedCspBlocks=0;
const result={result:'FAIL',checks:[]};
const blockedExternalRequests=[];
const blockedWriteRequests=[];
try {
 const f=JSON.parse(readFileSync(0,'utf8').replace(/^\uFEFF/,''));
 assert.equal(f.synthetic,true);assert.match(f.nonce,/^[a-f0-9]{32}$/);
 assert.equal(f.marker,'Phase4 Cash '+f.nonce);assert.equal(f.deviceKey,'phase4-'+f.nonce);
 assert(Number.isSafeInteger(f.tenantId)&&![1,23,25].includes(f.tenantId));
 assert.equal(f.products.length,2);assert.deepEqual(f.products.map(p=>p.price),[500,200]);
 const base=new URL(process.env.BASE_URL);assert.equal(base.href,base.origin+'/');
 const remote=base.origin==='https://scanaki.uk';
 assert(remote||(base.protocol==='http:'&&['haproxy','localhost','127.0.0.1'].includes(base.hostname)));
 assert.deepEqual(process.argv.slice(2).sort(),(remote?['--execute','--allow-synthetic','--allow-remote-synthetic']:['--execute','--allow-synthetic']).sort());
 browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=browser.defaultBrowserContext();
 await context.setCookie({name:'access_token',value:f.token,url:base.origin,httpOnly:true,secure:remote,sameSite:'Lax'});
 const itemIds=new Set();
 const previewPath='/__phase4-receipt-'+f.nonce;let receiptHeaders={};
 function safePath(path){return path.split(f.tableToken).join('[table-token]').split(f.token).join('[session-token]').replace(/(\/menu\/)[^/]+/g,'$1[table-token]');}
 async function guardPage(p,allowWrites=true){
  p.setDefaultTimeout(15000);
  if(allowWrites)await p.evaluateOnNewDocument(key=>{localStorage.setItem('pos_language','en');localStorage.setItem('one-table-kds-device-key',key);},f.deviceKey);
  p.on('pageerror',()=>errors++);await p.setRequestInterception(true);
  p.on('request',r=>{
   const previewUrl=new URL(r.url());
   if(!allowWrites&&r.method()==='GET'&&r.isNavigationRequest()&&r.frame()===p.mainFrame()&&previewUrl.origin===base.origin&&previewUrl.pathname===previewPath){return void r.respond({status:200,contentType:'text/html',headers:receiptHeaders,body:'<!doctype html><html><body></body></html>'});}
   const u=new URL(r.url());if(['http:','https:'].includes(u.protocol)&&u.origin!==base.origin){external++;blockedExternalRequests.push({method:r.method(),hostname:u.hostname,pathname:safePath(u.pathname),guard_probe:guardProbeActive&&!allowWrites});return void r.abort();}
   if(!['GET','HEAD','OPTIONS'].includes(r.method())){
    if(!allowWrites){blocked++;blockedWriteRequests.push({method:r.method(),pathname:safePath(u.pathname),guard_probe:guardProbeActive});return void r.abort();}
    let ok=false;try {const b=JSON.parse(r.postData()||'{}');
     ok=r.method()==='POST'&&['/api/tenant/kitchen-devices/pulse','/api/tenant/kitchen-devices/heartbeat'].includes(u.pathname)&&b.device_key===f.deviceKey&&['kitchen','bar'].includes(b.display_route)&&b.station_id==null&&['Kitchen tablet','Bar tablet'].includes(b.name);
     ok ||= r.method()==='POST'&&u.pathname==='/api/tenant/kitchen-devices/diagnostics'&&b.device_key===f.deviceKey&&Array.isArray(b.events)&&b.events.length>0&&b.events.length<=50&&b.events.every(e=>e.source==='web'&&['failure','recovered','heartbeat_gap','auth_failure'].includes(e.outcome));
     ok ||= r.method()==='POST'&&u.pathname===`/api/menu/${f.tableToken}/order`&&b.notes===f.marker&&b.idempotency_key===f.nonce&&b.items?.length===2&&b.items.every((x,i)=>x.product_id===f.products[i].id&&x.quantity===1);
     ok ||= orderId&&r.method()==='PUT'&&u.pathname===`/api/orders/${orderId}/mark-paid`&&b.payment_method==='cash'&&b.tip_percent===0&&b.tip_amount_cents===undefined;
     ok ||= orderId&&r.method()==='PUT'&&[...itemIds].some(id=>u.pathname===`/api/orders/${orderId}/items/${id}/status`)&&['preparing','ready','delivered'].includes(b.status);
    }catch{}if(!ok){blocked++;blockedWriteRequests.push({method:r.method(),pathname:safePath(u.pathname),guard_probe:false});return void r.abort();}
   }return void r.continue();
  });return p;
 }
 async function page(){return guardPage(await context.newPage());}
 const staff=await page();const staffDocument=await staff.goto(base.origin+'/staff/orders',{waitUntil:'networkidle2'});assert(staffDocument,'Staff document response unavailable');const staffDocumentHeaders=staffDocument.headers();
 async function api(path,method='GET',body){const r=await staff.evaluate(async({path,method,body})=>{const r=await fetch('/api'+path,{method,credentials:'include',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:r.status,body:await r.json()};},{path,method,body});assert(r.status>=200&&r.status<300);return r.body;}
 assert.equal((await api('/users/me')).tenant_id,f.tenantId);
 const settings=await api('/tenant/settings');assert.equal(settings.name,f.marker);assert.equal(settings.tse_mode,'off');assert.equal(settings.immediate_payment_required,false);
 assert.equal((await api('/print-jobs/status')).agent_online,false);
 assert.deepEqual(await api('/orders'),[]);
 const date=new Date().toISOString().slice(0,10),reportPath=`/reports/sales?from_date=${date}&to_date=${date}`;
 const before=await api(reportPath);assert.equal(before.summary.total_orders,0);assert.equal(before.summary.total_revenue_cents,0);
 stage='create real cash-payable order';
 const payload={items:f.products.map(p=>({product_id:p.id,quantity:1,source:'product',notes:f.marker})),notes:f.marker,session_id:f.nonce,idempotency_key:f.nonce,location_confirmed:true};
 const created=await api(`/menu/${f.tableToken}/order`,'POST',payload);orderId=created.order_id;assert(Number.isSafeInteger(orderId)&&![147,149,157].includes(orderId));
 assert.equal((await api(`/menu/${f.tableToken}/order`,'POST',payload)).order_id,orderId);
 let order=(await api('/orders')).find(o=>o.id===orderId);assert(order);assert.equal(order.items.length,2);order.items.forEach(i=>itemIds.add(i.id));
 result.checks.push('real order creation and duplicate idempotency');
 stage='cash settlement';await api(`/orders/${orderId}/mark-paid`,'PUT',{payment_method:'cash',tip_percent:0});
 const payment=await api(`/orders/${orderId}/payments`);assert.equal(payment.amount_due_cents,700);assert.equal(payment.amount_paid_cents,700);assert.equal(payment.amount_remaining_cents,0);
 assert.equal(payment.payments.length,1);assert.equal(payment.payments[0].payment_method,'cash');result.checks.push('single cash700 payment and reconciliation');
 const displays=[];
 for(const [index,route] of ['kitchen','bar'].entries()){
  stage=route+' paid ticket';const p=await page();displays.push(p);await p.goto(base.origin+'/'+route,{waitUntil:'networkidle2'});
  try {await p.waitForSelector(`[data-order-id="${orderId}"]`,{visible:true});} catch(e) {
   const snapshot=(await api('/orders')).find(o=>o.id===orderId);
   const feed=await api('/orders/kitchen-feed');
   result.feed_diagnostic={contains_fixture:feed.some(o=>o.id===orderId),requires_prepayment:snapshot?.requires_prepayment,released:!!snapshot?.kitchen_released_at};
   result.view_diagnostic=await p.evaluate(()=>{const c=window.ng?.getComponent(document.querySelector('app-kitchen-display'));return c?{view:c.viewMode(),station:c.stationSelection(),location:c.locationSelection(),raw_ids:c.orders().map(o=>o.id),active_ids:c.activeOrders().map(o=>o.id)}:null;});
   result.ticket_diagnostic={route,at_expected_route:new URL(p.url()).pathname==='/'+route,card_count:await p.$$eval('[data-order-id]',els=>els.length),status:snapshot?.status,paid:!!snapshot?.paid_at,items:snapshot?.items.map(i=>({status:i.status,category:i.category,kitchen_station_route:i.kitchen_station_route}))};throw e;
  }
  const text=await p.$eval(`[data-order-id="${orderId}"]`,e=>e.textContent);
  assert(text.includes(f.products[index].name));assert(!text.includes(f.products[1-index].name));
  result.checks.push(route+' shows only assigned product');
 }
 stage='real fulfillment transitions';
 for(const status of ['preparing','ready']){
  for(const id of itemIds)await api(`/orders/${orderId}/items/${id}/status`,'PUT',{status});
  order=(await api('/orders')).find(o=>o.id===orderId);assert(order.items.every(i=>i.status===status));
 }
 for(const p of displays){await p.reload({waitUntil:'networkidle2'});await p.waitForSelector(`[data-order-id="${orderId}"]`);assert(await p.$eval(`[data-order-id="${orderId}"]`,e=>/ready/i.test(e.textContent)));}
 for(const id of itemIds)await api(`/orders/${orderId}/items/${id}/status`,'PUT',{status:'delivered'});
 order=(await api('/orders')).find(o=>o.id===orderId);assert.equal(order.status,'completed');assert(order.items.every(i=>i.status==='delivered'));result.checks.push('preparing/ready DOM/delivered/completed');
 stage='receipt popup';await staff.bringToFront();const receiptHostResponse=await staff.goto(`${base.origin}/staff/orders?focusOrder=${orderId}`,{waitUntil:'networkidle2'});await staff.waitForSelector('.modal-order-edit .modal-actions');
 // Same-document navigation can return null; its security policy remains that of the existing document.
 const hostHeaders=receiptHostResponse?receiptHostResponse.headers():staffDocumentHeaders;result.receipt_document_source=receiptHostResponse?'navigation-response':'existing-document';receiptHeaders=Object.fromEntries(['content-security-policy','cross-origin-opener-policy','cross-origin-embedder-policy','origin-agent-cluster'].filter(k=>hostHeaders[k]).map(k=>[k,hostHeaders[k]]));
 result.receipt_buttons=await staff.$$eval('.modal-order-edit .modal-actions button',buttons=>buttons.map(b=>b.textContent.trim()));
 const popup=new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),15000);staff.once('popup',p=>{clearTimeout(timer);resolve(p);});});
 // Open only a blank same-origin window; install guards before the application writes any receipt HTML.
 await staff.evaluate(name=>{const preview=window.open('about:blank',name);window.__phase4ReceiptOpenCalls=0;window.open=(url,target)=>{if(url!==''||target!=='_blank')throw new Error('Unexpected receipt window request');window.__phase4ReceiptOpenCalls++;window.__phase4PreviewClosed=preview?.closed;return preview;};},'phase4-receipt-'+f.nonce);
 const receipt=await popup;assert(receipt,'Receipt preview unavailable');assert.equal(receipt.url(),'about:blank');await guardPage(receipt,false);
 // Establish a concrete same-origin document while the guards are already active.
 await receipt.goto(base.origin+previewPath,{waitUntil:'load'});
 await receipt.evaluate(()=>{window.__prints=0;window.print=()=>window.__prints++;window.close=()=>{};});
 stage='receipt request guards';guardProbeActive=true;
 const writesBefore=blocked;
 await receipt.evaluate(async url=>{await fetch(url,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)}).catch(()=>{});},base.origin+`/api/menu/${f.tableToken}/order`);
 assert.equal(blocked,writesBefore+1);assert.equal(blockedWriteRequests.at(-1).pathname,'/api/menu/[table-token]/order');expectedWriteBlocks++;
 const externalProbe=await receipt.evaluate(async()=>{
  let resolveViolation,timer;const violation=new Promise(resolve=>resolveViolation=resolve);
  const onViolation=e=>{try{if(new URL(e.blockedURI).origin==='https://phase4-guard.invalid'&&e.disposition==='enforce'&&['connect-src','default-src'].includes(e.effectiveDirective))resolveViolation(true);}catch{}};
  document.addEventListener('securitypolicyviolation',onViolation);
  try{const completed=await fetch('https://phase4-guard.invalid/probe',{credentials:'omit',signal:AbortSignal.timeout(3000)}).then(()=>true,()=>false);const csp=await Promise.race([violation,new Promise(resolve=>timer=setTimeout(()=>resolve(false),1000))]);return {completed,csp};}
  finally{clearTimeout(timer);document.removeEventListener('securitypolicyviolation',onViolation);}
 });
 assert.equal(externalProbe.completed,false);
 const interceptedProbes=blockedExternalRequests.filter(r=>r.guard_probe&&r.hostname==='phase4-guard.invalid'&&r.pathname==='/probe').length;
 if(interceptedProbes===1)expectedExternalBlocks++;else{assert.equal(interceptedProbes,0);assert.equal(externalProbe.csp,true);expectedCspBlocks++;}
 guardProbeActive=false;
 assert(!JSON.stringify([...blockedWriteRequests,...blockedExternalRequests]).includes(f.tableToken));
 await staff.bringToFront();await staff.click('.modal-order-edit .modal-actions button:nth-child(3)');await receipt.bringToFront();stage='receipt rendered';
 try{await receipt.waitForFunction(()=>window.__prints===1&&document.querySelector('.total-row'));}catch(e){result.receipt_diagnostic=await receipt.evaluate(()=>({prints:window.__prints??null,total_present:!!document.querySelector('.total-row'),content_type:document.contentType,ready:document.readyState}));result.receipt_open_diagnostic=await staff.evaluate(()=>({calls:window.__phase4ReceiptOpenCalls,closed:window.__phase4PreviewClosed??null}));throw e;}
 assert.equal(await staff.evaluate(()=>window.__phase4ReceiptOpenCalls),1);
 const value=await receipt.evaluate(()=>({text:document.body.innerText,total:document.querySelector('.total-row td:last-child').textContent}));
 assert(f.products.every(p=>value.text.includes(p.name)));assert.equal(Math.round(Number(value.total.replace(/[^0-9.]/g,''))*100),700);stage='receipt PDF';await receipt.bringToFront();await receipt.emulateMediaType('print');const pdf=await receipt.pdf({format:'A4',printBackground:true,timeout:15000});assert.equal(Buffer.from(pdf).subarray(0,5).toString(),'%PDF-');result.checks.push('actual two-item receipt700 and PDF; no physical output');
 stage='sales report reconciliation';assert.equal(new Date().toISOString().slice(0,10),date);const after=await api(reportPath);assert.equal(after.summary.total_orders,1);assert.equal(after.summary.total_revenue_cents,700);result.checks.push('fixture sales report one order revenue700');
 assert.equal(blocked,expectedWriteBlocks);assert.equal(errors,0);
 // These known stylesheet attempts remain blocked; any other external request fails.
 assert(blockedExternalRequests.every(r=>r.method==='GET'&&((r.hostname==='fonts.googleapis.com'&&r.pathname==='/css2')||(r.hostname==='fonts.gstatic.com'&&/^\/s\/inter\/v\d+\/[A-Za-z0-9_-]+\.woff2?$/.test(r.pathname))||(r.guard_probe&&r.hostname==='phase4-guard.invalid'&&r.pathname==='/probe'))));
 result.expected_guard_probe_blocks={writes:expectedWriteBlocks,external:expectedExternalBlocks,csp:expectedCspBlocks};result.blocked_font_assets=external-expectedExternalBlocks;result.result='PASS';result.tenant_id=f.tenantId;result.order_id=orderId;
}catch(e){result.stage=stage;result.error_type=e.name;}finally{await browser?.close();result.blocked_writes=blocked;result.blocked_write_requests=blockedWriteRequests;result.external_requests_blocked=external;result.blocked_external_requests=blockedExternalRequests;result.browser_errors=errors;result.utc=new Date().toISOString();console.log(JSON.stringify(result));if(result.result!=='PASS')process.exitCode=1;}

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');
const root = path.resolve(__dirname, '..');
function harness(options = {}, faults = {}) {
  let now = faults.now || 100000;
  const timers = [], sent = [];
  const clock = class extends Date { static now() { return now; } };
  const setTimeout = (fn, delay) => { const t = { fn, at: now + Number(delay), unref() { this.unreffed = true; } }; timers.push(t); return t; };
  const clearTimeout = t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  const https = { request(options) {
    if (faults.construct) { faults.construct = false; throw new Error('HTTPS construction'); }
    const req = new EventEmitter(); req.options = options; req.at = now; req.chunks = [];
    req.setTimeout = (_, fn) => { req.timeout = fn; }; req.write = chunk => req.chunks.push(chunk);
    req.abort = () => req.emit('abort'); req.end = data => { req.data = data; sent.push(req); }; return req;
  } };
  function load(relative, extra = {}) {
    const filename = path.join(root, relative), native = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
      require: name => name in extra ? extra[name] : native(name), Date: clock, setTimeout, clearTimeout, Buffer, console }, { filename });
    return module.exports;
  }
  const Bucket = load('lib/util/SequentialBucket.js');
  const Handler = load('lib/rest/RequestHandler.js', { https, '../util/SequentialBucket': Bucket });
  const client = new EventEmitter(); client.options = {}; client._token = 'synthetic'; client.on('error', () => {});
  const handler = new Handler(client, { disableLatencyCompensation: true, ...options });
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  function respond(index, status, headers = {}, body = '') {
    const resp = new EventEmitter(); resp.statusCode = status; resp.headers = { date: new Date(now).toUTCString(), ...headers };
    sent[index].emit('response', resp); if (body) resp.emit('data', body); resp.emit('end'); return resp;
  }
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      timers.sort((a,b) => a.at - b.at);
      if (!timers.length || timers[0].at > target) break;
      const t = timers.shift(); now = t.at; t.fn(); await flush();
    }
    now = target; await flush();
  }
  return { handler, client, sent, timers, respond, advance, flush };
}
const callback = '/interactions/1/token/callback';
const url = '/webhooks/123456789012345678/' + 'x'.repeat(64) + '/messages/@original';
for (const [method, endpoint, override, bypass] of [
  ['POST', callback, undefined, true], ['POST', callback + '?with_response=true', '/wrong', true],
  ['GET', callback, undefined, false], ['post', callback, undefined, false],
  ['POST', '/other', '/interactions/:id/:token/callback', false],
  ['POST', callback + '/extra', undefined, false], ['POST', '/interactions//token/callback', undefined, false],
  ['PATCH', url, undefined, false], ['POST', '/webhooks/1/token', undefined, false],
]) test(`classification ${method} ${endpoint} ${override}`, async () => {
  const h = harness(); const p = h.handler.request(method, endpoint, true, undefined, undefined, override);
  await h.flush(); assert.equal(h.sent.length, 1); assert.equal(Object.keys(h.handler.ratelimits).length, bypass ? 0 : 1);
  h.respond(0, 204); await p;
});
test('global exemption is exclusive; startup is preserved', async () => {
  for (const startup of [false,true]) {
    const h = harness({ forceQueueing: startup }); h.handler.globalBlock = true; h.handler.globalRatelimit = !startup;
    const p = h.handler.request('POST',callback,true); await h.flush();
    assert.equal(h.sent.length,startup ? 0 : 1); assert.equal(h.handler.readyQueue.length,startup ? 1 : 0);
    h.handler.globalUnblock(); await h.flush(); assert.equal(h.sent.length,1); h.respond(0,204); await p;
    h.handler.globalUnblock(); await h.flush(); assert.equal(h.sent.length,1);
  }
});
test('callback burst has no bucket and accepts JSON', async () => {
  const h = harness(), ps = [];
  for (let i=0;i<40;i++) ps.push(h.handler.request('POST',`/interactions/${i}/t/callback`,false));
  await h.flush(); assert.equal(h.sent.length,40); assert.equal(Object.keys(h.handler.ratelimits).length,0);
  for(let i=0;i<40;i++) h.respond(i,200,{'content-type':'application/json'},'{"ok":true}');
  assert((await Promise.all(ps)).every(v=>v.ok));
});
test('callback 429 retry, rejectOn429 stripping, timeout and 502 are bucket-free', async () => {
  const h=harness(); const a=h.handler.request('POST',callback,false,{type:4}); await h.flush();
  h.respond(0,429,{'retry-after':'0.02'},'{"retry_after":0.02}'); await h.advance(20);
  assert.equal(h.sent.length,2); h.respond(1,502); await h.advance(2000); assert.equal(h.sent.length,3);
  h.respond(2,204); await a;
  const body={type:4,rejectOn429:true};const b=h.handler.request('POST',callback,false,body).catch(e=>e);await h.flush();
  assert.equal(JSON.parse(h.sent[3].data).rejectOn429,undefined); assert.equal(body.rejectOn429,true);
  h.respond(3,429,{'content-type':'application/json'},'{"retry_after":0}');assert((await b).message);
  const c=h.handler.request('POST',callback,false).catch(e=>e);await h.flush();h.sent[4].timeout();assert.match((await c).message,/timed out/);
  assert.equal(Object.keys(h.handler.ratelimits).length,0);
});

// Shared S01/S02 coverage, concatenated into the applied test file.
test('actual Client adapters forward endpoint, auth, payload, file and override',async()=>{
  const filename=path.join(root,'lib/Client.js'), native=createRequire(filename), module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,console,require:n=>{
    if(n==='events'||n==='eventemitter3') return EventEmitter;
    if(n==='./rest/Endpoints'||n==='./Constants')return native(n);
    return class { constructor(data){this.data=data;} };
  }});
  const client=Object.create(module.exports.prototype), calls=[];
  client.requestHandler={request:(...args)=>{calls.push(args);return Promise.resolve({id:'reply'});}};
  const body={type:4,data:{content:'hello'},with_response:true}, file={file:Buffer.from('x'),name:'x.txt'};
  await client.createInteractionResponse('1','token',body,file);
  assert.equal(calls[0][0],'POST');assert.equal(calls[0][1],callback+'?with_response=true');assert.equal(calls[0][2],true);
  assert.equal(calls[0][3].payload_json,body);assert.equal(calls[0][4],file);assert.equal(calls[0][5],'/interactions/:id/:token/callback');
  const edit={content:'edit',file};await client.editWebhookMessage('123456789012345678','x'.repeat(64),'@original',edit);
  assert.equal(calls[1][0],'PATCH');assert.equal(calls[1][1],url);assert.equal(calls[1][2],false);assert.equal(calls[1][3].payload_json,edit);assert.equal(calls[1][4],file);assert.equal(calls[1].length,5);
});
for(const multipart of [false,true]) test(`control stripping ${multipart?'multipart':'GET query'} preserves input`,async()=>{
  const h=harness(), body=multipart?{payload_json:{content:'hi'},rejectOn429:true}:{limit:2,rejectOn429:true};
  const before=JSON.stringify(body), file=multipart?{file:Buffer.from('x'),name:'x.txt'}:undefined;
  const p=h.handler.request(multipart?'PATCH':'GET',url,false,body,file).catch(e=>e);await h.flush();
  const wire=multipart?Buffer.concat(h.sent[0].chunks.map(x=>Buffer.from(x))).toString():h.sent[0].options.path;
  assert(!wire.includes('rejectOn429'));assert(wire.includes(multipart?'payload_json':'limit=2'));assert.equal(JSON.stringify(body),before);
  h.respond(0,429,{'content-type':'application/json','retry-after':'0'},'{}');assert.equal((await p).name,'DiscordHTTPError');await h.advance(5);assert.equal(h.sent.length,1);
});
for(const kind of ['construct','gzip','deflate'])test(`transport failure ${kind} releases queue`,async()=>{
  const h=harness({}, {construct:kind==='construct'}), p=h.handler.request('PATCH',url,false).catch(e=>e);await h.flush();
  if(kind!=='construct'){
    const {PassThrough}=require('stream');const resp=new PassThrough();resp.headers={'content-encoding':kind};resp.statusCode=200;
    h.sent[0].emit('response',resp);resp.end(Buffer.from('not a compressed stream'));
  }
  assert((await p).message);const bucket=Object.values(h.handler.ratelimits)[0];assert.equal(bucket.processing,false);
  const q=h.handler.request('PATCH',url,false);await h.flush();await h.advance(2);h.respond(h.sent.length-1,204);await q;
});
test('normal route normalization matches explicit baseline cases',()=>{
  const h=harness(), id='123456789012345678', other='223456789012345678';
  for(const [method,u,expected] of [
    ['GET',`/channels/${id}/messages/${other}`,`/channels/${id}/messages/:id`],
    ['PATCH',`/guilds/${id}/members/${other}`,`/guilds/${id}/members/:id`],
    ['GET',`/guilds/${id}/channels`,'/guilds/:id/channels'],
    ['POST',`/guilds/${id}/channels`,`/guilds/${id}/channels`],
    ['GET',`/channels/${id}/messages/${other}/reactions/emoji/${other}`,`/channels/${id}/messages/:id/reactions/:id/:userID`],
    ['PUT',`/channels/${id}/messages/${other}/reactions/emoji/@me`,`MODIFY/channels/${id}/messages/:id/reactions`],
    ['DELETE',`/channels/${id}/messages/${other}/reactions/emoji/@me`,`MODIFY/channels/${id}/messages/:id/reactions`],
  ])assert.equal(h.handler.routefy(u,method),expected);
  const hash=require('crypto').createHash('sha256').update('x'.repeat(64)).digest('hex');assert.equal(h.handler.routefy(url,'PATCH'),`/webhooks/${id}/${hash}/messages/@original`);
  assert.notEqual(h.handler.routefy(url,'PATCH'),h.handler.routefy(url.replace('x'.repeat(64),'y'.repeat(64)),'PATCH'));
});
for(const offset of [0,25,100])test(`normal route cooldown with latency offset ${offset}`,async()=>{
  const h=harness({ratelimiterOffset:offset}), a=h.handler.request('GET','/normal',false), b=h.handler.request('GET','/normal',false);await h.flush();
  h.respond(0,204,{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'0.05'});await a;
  await h.advance(50+offset);assert.equal(h.sent.length,1);await h.advance(1);assert.equal(h.sent.length,2);h.respond(1,204);await b;
});
test('latency compensation updates moving average without changing routes',async()=>{
  const h=harness({disableLatencyCompensation:false,ratelimiterOffset:20});const p=h.handler.request('GET','/normal',false);await h.flush();await h.advance(100);h.respond(0,204);await p;assert.equal(h.handler.latencyRef.latency,28);
});

for(const offset of [0,25,100])test(`DELETE message age normalization boundaries offset=${offset}`,()=>{
  const now=1700000000000, h=harness({ratelimiterOffset:offset},{now}), channel='123456789012345678';
  const old=14*24*60*60*1000;
  for(const [age,prefix] of [[9999,'DELETE_NEW'],[10000,'DELETE_NEW'],[10001,'DELETE'],[old-1,'DELETE'],[old,'DELETE_OLD'],[old+1,'DELETE_OLD']]){
    const id=((BigInt(now-offset-age)-1420070400000n)<<22n).toString();
    assert.equal(h.handler.routefy(`/channels/${channel}/messages/${id}`,'DELETE'),`${prefix}/channels/${channel}/messages/:id`);
  }
});

for(const [label,endpoint,headers,reset,wait] of [
  ['absolute','/normal',{'x-ratelimit-reset':'101'},100975,1001],
  ['non429 Retry-After','/normal',{'retry-after':'0.05'},100050,76],
  ['reaction workaround','/channels/123456789012345678/messages/223456789012345678/reactions/emoji',{'x-ratelimit-reset':'101'},100225,251],
])test(`normal reset semantics ${label}`,async()=>{
  const h=harness({ratelimiterOffset:25}),p=h.handler.request('GET',endpoint,false),q=h.handler.request('GET',endpoint,false);await h.flush();
  h.respond(0,204,{'x-ratelimit-remaining':'0',...headers});await p;assert.equal(Object.values(h.handler.ratelimits)[0].reset,reset);await h.advance(wait-1);assert.equal(h.sent.length,1);await h.advance(1);assert.equal(h.sent.length,2);h.respond(1,204);await q;
});
test('callback global429 reject retains application-global bookkeeping',async()=>{
 const h=harness(),p=h.handler.request('POST',callback,true,{rejectOn429:true}).catch(e=>e);await h.flush();
 h.respond(0,429,{'retry-after':'0.05'},'{}');await p;
 const q=h.handler.request('POST',callback,true,{rejectOn429:true}).catch(e=>e);await h.flush();
 h.respond(1,429,{'retry-after':'0.05','x-ratelimit-global':'true'},'{}');await q;
 assert.equal(h.handler.globalBlock,true);assert.equal(Object.keys(h.handler.ratelimits).length,0);
 await h.advance(50);assert.equal(h.handler.globalBlock,false);
});

// S02_ONLY
for (const [body,header,delay] of [
  ['{"retry_after":0.08}','0.02',80], ['{"retry_after":0}','1',0],
  ['{"retry_after":0.0015}',undefined,1.5], ['invalid','0.03',30],
  ['0','0.03',30], ['-0','0.03',30],
  ['{"retry_after":null}','0.03',30], ['{"retry_after":-1}','0.03',30],
  ['{"retry_after":"0.01"}','0.03',30], ['{"retry_after":1e999}','0.03',30],
]) test(`429 timing ${body} ${header}`, async () => {
  const h=harness(); const a=h.handler.request('PATCH',url,false,{content:'A'}), b=h.handler.request('PATCH',url,false,{content:'B'});
  await h.flush(); h.respond(0,429,{'content-type':'application/json','retry-after':header,'x-ratelimit-remaining':'9','x-ratelimit-reset-after':'0'},body);
  if(delay) { await h.advance(delay-0.1); assert.equal(h.sent.length,1); await h.advance(0.1); } else await h.advance(0);
  assert.equal(h.sent.length,2); assert.equal(h.sent[1].at,100000+delay); assert.equal(JSON.parse(h.sent[1].data).content,'A');
  h.respond(1,204); await h.flush(); assert.equal(JSON.parse(h.sent[2].data).content,'B'); h.respond(2,204); await Promise.all([a,b]);
  assert.equal(Object.values(h.handler.ratelimits)[0].owners,0);
});
for(const body of ['invalid','{}','{"retry_after":null}','{"retry_after":-1}','{"retry_after":1e999}']) test(`invalid retry releases ${body}`,async()=>{
  const h=harness(); const a=h.handler.request('PATCH',url,false).catch(e=>e), b=h.handler.request('PATCH',url,false);
  await h.flush(); h.respond(0,429,{'x-ratelimit-scope':'shared','retry-after':''},body); assert.match((await a).message,/Invalid 429/);
  await h.flush(); assert.equal(h.sent.length,2); h.respond(1,204); await b;
});
for(const body of ['0','-0'])for(const header of [undefined,'invalid'])test(`zero-root invalid retry releases ${body} ${header}`,async()=>{
  const h=harness(); let settled=0;
  const a=h.handler.request('PATCH',url,false,{content:'A'}).catch(e=>{settled++;return e;}), b=h.handler.request('PATCH',url,false,{content:'B'});
  await h.flush(); const bucket=Object.values(h.handler.ratelimits)[0]; assert.equal(bucket.owners,2);
  const resp=h.respond(0,429,{'content-type':'application/json','x-ratelimit-scope':'shared','retry-after':header},body);
  await h.flush(); assert.equal(settled,1); assert.match((await a).message,/Invalid 429 retry delay/);
  assert.equal(bucket.owners,1); assert.equal(h.sent.length,2); assert.equal(JSON.parse(h.sent[1].data).content,'B');
  resp.emit('end'); resp.emit('aborted'); await h.advance(0); assert.equal(settled,1); assert.equal(bucket.owners,1); assert.equal(h.sent.length,2);
  h.respond(1,204); await b; assert.equal(bucket.owners,0); assert.equal(bucket.processing,false);
});
test('502 releases slot, retains owner, and preserves more than four retries',async()=>{
  const h=harness(); const a=h.handler.request('PATCH',url,false,{content:'A'}), b=h.handler.request('PATCH',url,false,{content:'B'});
  await h.flush(); const bucket=Object.values(h.handler.ratelimits)[0]; h.respond(0,502); await h.flush();
  assert.equal(JSON.parse(h.sent[1].data).content,'B'); assert.equal(bucket.owners,2); h.respond(1,204); await b;
  assert.equal(bucket.owners,1); await h.advance(2000);
  for(let i=0;i<5;i++){ h.respond(h.sent.length-1,502); await h.advance(2000); }
  h.respond(h.sent.length-1,204); await a; assert.equal(bucket.owners,0);
});
test('late events do not retry or release twice; sweep retains active and expires idle',async()=>{
  const h=harness(); const p=h.handler.request('PATCH',url,false).catch(e=>e); await h.flush();
  const bucket=Object.values(h.handler.ratelimits)[0]; assert(h.timers.find(t=>t.unreffed));
  await h.advance(30000); assert.equal(Object.values(h.handler.ratelimits)[0],bucket);
  h.sent[0].timeout(); await p; const resp=h.respond(0,429,{'retry-after':'0'},'{}'); resp.emit('aborted');
  await h.advance(0); assert.equal(h.sent.length,1); assert.equal(bucket.owners,0);
  await h.advance(30000); assert.equal(Object.keys(h.handler.ratelimits).length,0);
});
test('retry context and one completion',async()=>{
  const h=harness(), als=new AsyncLocalStorage(), events=[];
  const channel=require('diagnostics_channel').channel('eris.request.phase');
  const listener=e=>events.push([e,als.getStore()]); channel.subscribe(listener);
  try {
    const p=als.run('A',()=>h.handler.request('PATCH',url,false)); await h.flush();
    h.respond(0,429,{'retry-after':'0'},'{}'); await h.advance(0); h.respond(1,204); await p;
    const complete=events.filter(([e])=>e.event==='complete'); assert.equal(complete.length,1); assert.equal(complete[0][0].attempts,2);
    assert.equal(complete[0][1],'A'); assert(events.filter(([e])=>e.event==='start' && e.phase.labels.attempt===2).every(([,ctx])=>ctx==='A'));
  } finally { channel.unsubscribe(listener); }
});

test('route cooldown longer than authoritative delay consumes retry token',async()=>{
  const h=harness(); const a=h.handler.request('PATCH',url,false), b=h.handler.request('PATCH',url,false);
  await h.flush(); h.respond(0,429,{'retry-after':'0.01','x-ratelimit-reset-after':'0.1','x-ratelimit-remaining':'0'},'{}');
  await h.advance(100); assert.equal(h.sent.length,1); await h.advance(1); assert.equal(h.sent.length,2);
  assert.equal(Object.values(h.handler.ratelimits)[0].remaining,0); h.respond(1,204); await h.flush(); h.respond(2,204); await Promise.all([a,b]);
});
test('callback global 429 uses body delay with no bucket',async()=>{
  const h=harness(); const a=h.handler.request('POST',callback,true);
  await h.flush(); h.respond(0,429,{'x-ratelimit-global':'true','x-ratelimit-reset-after':'0.001','retry-after':'0.002'},'{"retry_after":0.05}');
  const b=h.handler.request('GET','/normal',true); await h.flush(); assert.equal(h.sent.length,1);
  await h.advance(49); assert.equal(h.sent.length,1); await h.advance(1); assert.equal(h.sent.length,3);
  h.respond(1,204); h.respond(2,204); await Promise.all([a,b]); assert.equal(Object.keys(h.handler.ratelimits).length,1);
});
for (const kind of ['serialization','multipart','abort','error','response-abort','json','http','reject429']) test(`terminal ${kind} releases owner`,async()=>{
  const h=harness(); let body, file;
  if(kind==='serialization'){body={};body.self=body;}
  if(kind==='multipart')file={};
  if(kind==='reject429')body={rejectOn429:true};
  const a=h.handler.request('PATCH',url,false,body,file).catch(e=>e); await h.flush();
  if(h.sent.length){
    if(kind==='abort') h.sent[0].abort();
    else if(kind==='error') h.sent[0].emit('error',new Error('synthetic'));
    else if(kind==='response-abort') {const resp=new EventEmitter(); resp.headers={}; h.sent[0].emit('response',resp);resp.emit('aborted');}
    else h.respond(0,kind==='json'?200:kind==='reject429'?429:400,{'content-type':'application/json'},kind==='json'?'bad':'{}');
  }
  assert((await a).message); const bucket=Object.values(h.handler.ratelimits)[0];assert.equal(bucket.owners,0);assert.equal(bucket.processing,false);
  const b=h.handler.request('PATCH',url,false);await h.flush();await h.advance(2);h.respond(h.sent.length-1,204);await b;
});

for(const endpoint of [callback,url])for(const valid of [true,false])test(`reject429 global bookkeeping ${endpoint} valid=${valid}`,async()=>{
  const h=harness(), p=h.handler.request('POST',endpoint,true,{rejectOn429:true}).catch(e=>e);await h.flush();
  h.respond(0,429,{'content-type':'application/json','x-ratelimit-global':'true','retry-after':valid?'0.001':''},valid?'{"retry_after":0.05}':'{}');
  assert.equal((await p).name,'DiscordHTTPError');assert.equal(h.handler.globalBlock,valid);
  const q=h.handler.request('GET','/normal',true);await h.flush();assert.equal(h.sent.length,valid?1:2);
  if(valid){await h.advance(49);assert.equal(h.sent.length,1);await h.advance(1);assert.equal(h.sent.length,2);}
  h.respond(1,204);await q;await h.advance(100);assert.equal(h.sent.length,2);
});
test('independent webhook proceeds and B arriving during sleep stays after A',async()=>{
  const h=harness(), a=h.handler.request('PATCH',url,false,{content:'A'});await h.flush();h.respond(0,429,{'retry-after':'0.1'},'{}');await h.advance(20);
  const b=h.handler.request('PATCH',url,false,{content:'B'}), c=h.handler.request('PATCH',url.replace('x'.repeat(64),'y'.repeat(64)),false,{content:'C'});await h.flush();
  assert.equal(h.sent.length,2);assert.equal(JSON.parse(h.sent[1].data).content,'C');h.respond(1,204);await c;
  await h.advance(80);assert.equal(JSON.parse(h.sent[2].data).content,'A');h.respond(2,204);await a;await h.flush();assert.equal(JSON.parse(h.sent[3].data).content,'B');h.respond(3,204);await b;
});
for(const retained of [false,true])test(`global block appearing during bucket wakeup retained=${retained}`,async()=>{
  const h=harness(), a=h.handler.request('PATCH',url,true);await h.flush();
  h.respond(0,retained?429:204,{'retry-after':'0.01','x-ratelimit-remaining':'0','x-ratelimit-reset-after':'0.1'},'{}');
  let b;if(!retained){await a;b=h.handler.request('PATCH',url,true);}await h.advance(20);
  const global=h.handler.request('POST',callback,true,{rejectOn429:true}).catch(e=>e);await h.flush();h.respond(1,429,{'retry-after':'0.2','x-ratelimit-global':'true'},'{}');await global;
  await h.advance(81);assert.equal(h.sent.length,2);assert.equal(h.handler.readyQueue.length,1);
  await h.advance(119);assert.equal(h.sent.length,3);h.respond(2,204);await (b||a);
});
test('idle eviction reacquires fresh identity; active replacement cannot be deleted',async()=>{
  const h=harness(), p=h.handler.request('PATCH',url,false);await h.flush();const route=h.handler.routefy(url,'PATCH'), old=h.handler.ratelimits[route];h.respond(0,204);await p;await h.advance(30000);assert.equal(h.handler.ratelimits[route],undefined);
  const q=h.handler.request('PATCH',url,false);await h.flush();const fresh=h.handler.ratelimits[route];assert.notEqual(fresh,old);await h.advance(30000);assert.equal(h.handler.ratelimits[route],fresh);h.respond(1,204);await q;
  // Force a replacement between sweep capture and its identity check.
  const replacement={owners:1,processing:true,_queue:[],reset:0};Object.defineProperty(fresh,'reset',{get(){h.handler.ratelimits[route]=replacement;return 0;}});
  await h.advance(30000);assert.equal(h.handler.ratelimits[route],replacement);
});
test('large unique webhook burst has one sweep and releases all idle buckets',async()=>{
  const h=harness(), ps=[];for(let i=0;i<1000;i++)ps.push(h.handler.request('PATCH',url.replace('x'.repeat(64),String(i).padStart(64,'x')),false));await h.flush();
  assert.equal(h.sent.length,1000);assert.equal(Object.keys(h.handler.ratelimits).length,1000);assert.equal(h.timers.filter(t=>t.unreffed).length,1);
  for(let i=0;i<1000;i++)h.respond(i,204);await Promise.all(ps);await h.advance(30000);assert.equal(Object.keys(h.handler.ratelimits).length,0);assert.equal(h.timers.length,0);
});
test('detached 502 ownership spans sweep and preserves debug message',async()=>{
  const h=harness(), debug=[];h.client.on('debug',s=>debug.push(s));const p=h.handler.request('PATCH',url,false);await h.flush();const bucket=Object.values(h.handler.ratelimits)[0];
  // Reply just before each two-second boundary; sweep at 30s occurs during detached sleep.
  for(let i=0;i<16;i++){await h.advance(1900);h.respond(h.sent.length-1,502);assert.equal(bucket.owners,1);assert.equal(bucket.processing,false);await h.advance(2000);assert.equal(Object.values(h.handler.ratelimits)[0],bucket);}
  h.respond(h.sent.length-1,204);await p;assert.equal(debug.filter(s=>s==='A wild 502 appeared! Thanks CloudFlare!').length,16);await h.advance(30000);assert.equal(Object.keys(h.handler.ratelimits).length,0);
});
test('retry preserves payload/file/control and baseline audit-reason behavior',async()=>{
  for(const multipart of [false,true]){
    const h=harness(), body={content:'A',reason:'audit%20reason',rejectOn429:true}, file=multipart?{file:Buffer.from('x'),name:'x'}:undefined, original=JSON.stringify(body);
    const p=h.handler.request('PATCH',url,false,body,file).catch(e=>e);await h.flush();h.respond(0,502);await h.advance(2000);
    assert.equal(h.sent[0].options.headers['X-Audit-Log-Reason'],'audit%20reason');assert.equal(h.sent[1].options.headers['X-Audit-Log-Reason'],undefined);assert.equal(JSON.stringify(body),original);
    if(!multipart)assert.equal(h.sent[0].data,h.sent[1].data);else for(const r of h.sent){const wire=Buffer.concat(r.chunks.map(x=>Buffer.from(x))).toString();assert(wire.includes('name="content"'));assert(!wire.includes('rejectOn429'));assert(!wire.includes('name="reason"'));}
    h.respond(1,429,{'retry-after':'0'},'{}');assert.equal((await p).name,'DiscordHTTPError');await h.advance(10);assert.equal(h.sent.length,2);
  }
});
test('phase pairs balance, details cap at eight, omitted and completion remain exact',async()=>{
  const h=harness(), events=[], channel=require('diagnostics_channel').channel('eris.request.phase'), listener=e=>events.push(e);channel.subscribe(listener);
  try{
    const p=h.handler.request('PATCH',url,true);await h.flush();
    for(let i=0;i<10;i++){h.respond(i,429,{'retry-after':'0'},'{}');await h.advance(0);}h.respond(10,204);await p;
    const starts=events.filter(e=>e.event==='start'), ends=events.filter(e=>e.event==='end'), completes=events.filter(e=>e.event==='complete');
    assert.equal(starts.length,16);assert.equal(ends.length,16);for(const e of starts)assert.equal(ends.filter(x=>x.phase===e.phase).length,1);
    assert(starts.every(e=>e.phase.labels.attempt<=8));assert.equal(completes.length,1);assert.equal(completes[0].attempts,11);assert.equal(completes[0].omitted,5);assert.deepEqual(Object.keys(completes[0].waits).sort(),['retry','route_queue']);
  }finally{channel.unsubscribe(listener);}
});

test('sweep requires a finite expired reset including latency and preserves queued state',async()=>{
  for(const reset of [NaN,Infinity,-Infinity,129950]){
    const h=harness({ratelimiterOffset:100}),p=h.handler.request('PATCH',url,false);await h.flush();h.respond(0,204);await p;
    const route=h.handler.routefy(url,'PATCH'),bucket=h.handler.ratelimits[route];bucket.reset=reset;await h.advance(30000);assert.equal(h.handler.ratelimits[route],bucket);
    bucket.reset=0;bucket._queue.push(()=>{});await h.advance(30000);assert.equal(h.handler.ratelimits[route],bucket);bucket._queue.length=0;await h.advance(30000);assert.equal(h.handler.ratelimits[route],undefined);
  }
});
test('body-only global rejection uses JSON delay independently of retry decision',async()=>{
  const h=harness(),p=h.handler.request('POST',callback,true,{rejectOn429:true}).catch(e=>e);await h.flush();
  h.respond(0,429,{'content-type':'application/json','retry-after':'0.001'},'{"global":true,"retry_after":0.05}');assert.equal((await p).name,'DiscordHTTPError');assert.equal(h.handler.globalBlock,true);
  await h.advance(49);assert.equal(h.handler.globalBlock,true);await h.advance(1);assert.equal(h.handler.globalBlock,false);assert.equal(h.sent.length,1);
});
test('ready phases balance across startup and a new global wakeup block',async()=>{
  const h=harness({forceQueueing:true}), events=[], channel=require('diagnostics_channel').channel('eris.request.phase'), listener=e=>events.push(e);channel.subscribe(listener);
  try{
    const p=h.handler.request('PATCH',url,true);await h.flush();h.handler.globalUnblock();await h.flush();h.respond(0,429,{'retry-after':'0.01','x-ratelimit-reset-after':'0.1','x-ratelimit-remaining':'0'},'{}');await h.advance(20);
    h.handler.globalBlock=true;h.handler.globalRatelimit=true;await h.advance(81);assert.equal(h.sent.length,1);h.handler.globalUnblock();await h.flush();h.respond(1,204);await p;
    const starts=events.filter(e=>e.event==='start'),ends=events.filter(e=>e.event==='end');assert.equal(starts.filter(e=>e.phase.name==='ready_queue').length,2);assert.equal(starts.length,ends.length);for(const e of starts)assert.equal(ends.filter(x=>x.phase===e.phase).length,1);assert.equal(events.filter(e=>e.event==='complete').length,1);
  }finally{channel.unsubscribe(listener);}
});

test('retained 429 preserves JSON/control and baseline audit-reason behavior',async()=>{
  const h=harness(),body={content:'same',reason:'why%20now',rejectOn429:false},before=JSON.stringify(body),p=h.handler.request('PATCH',url,false,body);await h.flush();h.respond(0,429,{'retry-after':'0.01'},'{}');await h.advance(10);
  assert.equal(h.sent[0].data,h.sent[1].data);assert.equal(h.sent[0].options.headers['X-Audit-Log-Reason'],'why%20now');assert.equal(h.sent[1].options.headers['X-Audit-Log-Reason'],undefined);assert.equal(JSON.stringify(body),before);h.respond(1,204);await p;
});
test('JSON null HTTP error releases logical ownership',async()=>{
 const h=harness(),p=h.handler.request('PATCH',url,false).catch(e=>e);await h.flush();
 h.respond(0,400,{'content-type':'application/json'},'null');assert.equal((await p).name,'DiscordHTTPError');
 assert.equal(Object.values(h.handler.ratelimits)[0].owners,0);
});

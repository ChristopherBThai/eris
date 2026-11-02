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

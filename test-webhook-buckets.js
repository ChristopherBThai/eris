"use strict";

// Offline regression tests: node test-webhook-buckets.js
const assert = require("assert");
const EventEmitter = require("events");
const HTTPS = require("https");
const RequestHandler = require("./lib/rest/RequestHandler");

const tokenA = "a".repeat(80);
const tokenB = "b".repeat(80);
const webhookID = "123456789012345678";
const url = (token, id = webhookID) => `/webhooks/${id}/${token}/messages/@original`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTransport(test) {
  const original = HTTPS.request;
  const requests = [];
  const client = new EventEmitter();
  client.options = {};
  const diagnostics = [];
  client.on("debug", (message) => diagnostics.push(message));
  client.on("warn", (message) => diagnostics.push(String(message)));
  client.on("rawREST", (request) => diagnostics.push(request.route));
  const handler = new RequestHandler(client, { disableLatencyCompensation: true });
  HTTPS.request = (options) => {
    const req = new EventEmitter();
    req.method = options.method;
    req.path = options.path;
    req.setTimeout = () => {};
    req.end = (data) => {
      req.data = data;
      requests.push(req);
    };
    req.respond = (status = 200, headers = {}, body = {}) => {
      const resp = new EventEmitter();
      resp.statusCode = status;
      resp.headers = { "date": new Date().toUTCString(), "content-type": "application/json", ...headers };
      req.emit("response", resp);
      resp.emit("data", JSON.stringify(body));
      resp.emit("end");
    };
    return req;
  };
  try {
    await test(handler, requests, diagnostics);
  } finally {
    // Tests run sequentially; no concurrent transport replacement is possible.
    // eslint-disable-next-line require-atomic-updates
    HTTPS.request = original;
    for (const bucket of Object.values(handler.ratelimits)) {
      clearTimeout(bucket.processing);
    }
  }
}

async function independence(handler, requests, diagnostics) {
  const a = handler.request("PATCH", url(tokenA), false, { content: "first" });
  const b = handler.request("PATCH", url(tokenB), false, { content: "second" });
  await tick();
  assert.strictEqual(requests.length, 2, "different webhook tokens must start independently");
  requests[1].respond();
  await b;
  assert.strictEqual(Object.keys(handler.ratelimits).length, 2);
  requests[0].respond();
  await a;
  const diagnosticState = JSON.stringify([diagnostics, handler.toJSON()]);
  for (const token of [tokenA, tokenB]) {
    assert(!diagnosticState.includes(token), "bucket identity and route diagnostics must not expose tokens");
  }
  assert(diagnostics.some((message) => message.includes(":token")));
  assert(Object.values(handler.ratelimits).every((bucket) => !bucket.skipQueue));
}

async function sameIdentity(handler, requests) {
  const a = handler.request("PATCH", url(tokenA), false);
  const b = handler.request("PATCH", url(tokenA), false);
  await tick();
  assert.strictEqual(requests.length, 1, "same identity must serialize in-flight requests");
  requests[0].respond(200, { "x-ratelimit-limit": "2", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.08" });
  await a;
  const bucket = Object.values(handler.ratelimits)[0];
  assert.strictEqual(bucket.limit, 2);
  assert.strictEqual(bucket.remaining, 0);
  const reset = bucket.reset;
  await wait(20);
  assert.strictEqual(requests.length, 1, "remaining=0 must hold the same identity until reset");
  while (requests.length < 2 && Date.now() < reset + 1000) {
    await wait(1);
  }
  assert.strictEqual(requests.length, 2);
  assert(Date.now() >= reset);
  requests[1].respond();
  await b;
  assert.strictEqual(Object.keys(handler.ratelimits).length, 1);
}

async function retry(handler, requests, diagnostics, shared = false) {
  const a = handler.request("PATCH", url(tokenA), false);
  await tick();
  const started = Date.now();
  requests[0].respond(429, { "x-ratelimit-remaining": "0", "retry-after": shared ? "0.01" : "0.08", "x-ratelimit-scope": shared ? "shared" : "user" }, { retry_after: 0.08 });
  const b = handler.request("PATCH", url(tokenB), false);
  await tick();
  assert.strictEqual(requests.length, 2, "429 on one token must not hold a different token");
  requests[1].respond();
  await b;
  await wait(20);
  assert.strictEqual(requests.length, 2, "429 retry must respect retry-after");
  while (requests.length < 3 && Date.now() < started + 1000) {
    await wait(1);
  }
  assert.strictEqual(requests.length, 3);
  assert(Date.now() - started >= 80);
  assert.strictEqual(requests[2].path, requests[0].path);
  requests[2].respond();
  await a;
  assert.strictEqual(Object.keys(handler.ratelimits).length, 2, "retry must reuse its original bucket");
  assert(!JSON.stringify(diagnostics).includes(tokenA));
}

async function rejectOn429(handler, requests) {
  const body = { content: "test", rejectOn429: true };
  const a = handler.request("PATCH", url(tokenA), false, body);
  const rejected = assert.rejects(a, (err) => err.code === 429);
  await tick();
  assert.deepStrictEqual(JSON.parse(requests[0].data), { content: "test" });
  assert.strictEqual(body.rejectOn429, true);
  requests[0].respond(429, { "retry-after": "0.01" }, { retry_after: 0.01 });
  await rejected;
  await wait(20);
  assert.strictEqual(requests.length, 1, "rejectOn429 must not retry");
}

async function sharedRetry(handler, requests, diagnostics) {
  await retry(handler, requests, diagnostics, true);
}

async function globalGate(handler, requests) {
  handler.globalBlock = true;
  const a = handler.request("PATCH", url(tokenA), true);
  const b = handler.request("PATCH", url(tokenB), false);
  await tick();
  assert.strictEqual(requests.length, 1, "unauthenticated webhooks retain their global exemption");
  assert(requests[0].path.includes(tokenB));
  requests[0].respond();
  await b;
  handler.globalUnblock();
  await tick();
  assert.strictEqual(requests.length, 2);
  requests[1].respond();
  await a;
  assert.strictEqual(Object.keys(handler.ratelimits).length, 2);
}

async function callbacks(handler, requests) {
  const callback = `/interactions/${webhookID}/${tokenA}/callback`;
  const a = handler.request("POST", callback, false, { type: 6 });
  const b = handler.request("POST", callback, false, { type: 6 });
  await tick();
  assert.strictEqual(requests.length, 2, "interaction callbacks retain their existing queue bypass");
  assert(Object.values(handler.ratelimits).every((bucket) => bucket.skipQueue));
  requests.forEach((req) => req.respond());
  await Promise.all([a, b]);
}

async function otherRoutes(handler, requests) {
  const channel = "/channels/123456789012345678/messages";
  const a = handler.request("POST", channel, true);
  const b = handler.request("POST", channel, true);
  await tick();
  assert.strictEqual(requests.length, 1);
  assert.deepStrictEqual(Object.keys(handler.ratelimits), [channel]);
  requests[0].respond();
  await a;
  await tick();
  requests[1].respond();
  await b;
  const c = handler.request("PATCH", url(tokenA), false);
  const d = handler.request("PATCH", url(tokenA, "234567890123456789"), false);
  await tick();
  assert.strictEqual(requests.length, 4, "different webhook IDs remain independent");
  requests[2].respond();
  requests[3].respond();
  await Promise.all([c, d]);
}

(async () => {
  for (const test of [independence, sameIdentity, retry, sharedRetry, rejectOn429, globalGate, callbacks, otherRoutes]) {
    await withTransport(test);
    console.log(`PASS ${test.name}`);
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

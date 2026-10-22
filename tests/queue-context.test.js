"use strict";

const assert = require("node:assert/strict");
const { AsyncLocalStorage } = require("node:async_hooks");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const SequentialBucket = require("../lib/util/SequentialBucket");
const RequestHandler = require("../lib/rest/RequestHandler");

for (const predecessor of ["sampled", "unsampled", undefined]) {
  test(`route queue restores caller context after ${predecessor} predecessor`, () => {
    const context = new AsyncLocalStorage();
    const bucket = new SequentialBucket(10);
    let release;
    const seen = [];
    context.run(predecessor, () => bucket.queue((done) => { release = done; }));
    context.run("normal", () => bucket.queue((done) => { seen.push(context.getStore()); done(); }));
    context.run("priority", () => bucket.queue((done) => { seen.push(context.getStore()); done(); }, true));
    context.run(predecessor, release);
    assert.deepEqual(seen, ["priority", "normal"]);
    assert.equal(bucket.processing, false);
    assert.equal(bucket._queue.length, 0);
    assert.equal(context.getStore(), undefined);
  });
}

test("skipQueue stays synchronous and preserves its caller", () => {
  const context = new AsyncLocalStorage();
  const bucket = new SequentialBucket(1, { latency: 0 }, true);
  let called = false;
  context.run("caller", () => {
    bucket.queue((done) => { called = true; assert.equal(context.getStore(), "caller"); done(); });
    assert.equal(called, true);
  });
});

test("global unblock restores each ready request context", async () => {
  const context = new AsyncLocalStorage();
  const client = new EventEmitter();
  client.options = {};
  const handler = new RequestHandler(client, { forceQueueing: true });
  const seen = [];
  // Observe the existing bucket dispatch seam without making network requests.
  for (const id of ["a", "b"]) {
    handler.ratelimits[`/${id}`] = { queue() { seen.push(context.getStore()); } };
    context.run(id, () => handler.request("GET", `/${id}`, true));
  }
  assert.equal(handler.readyQueue.length, 2);
  context.run("unrelated", () => handler.globalUnblock());
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(handler.readyQueue.length, 0);
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Eris = require("../index");
const Shard = require("../lib/gateway/Shard");

const platforms = [
  "Discord VR",
  "Discord iOS",
  "Discord Android",
  "Discord Web",
  "Discord Embedded",
  "Discord Client",
];

function identifyFor(platform, id = 0, maxShards = 1) {
  const payloads = [];
  const shard = Object.create(Shard.prototype);
  shard.client = {
    options: { compress: false, largeThreshold: 250, intents: 1, maxShards, platform },
  };
  shard.id = id;
  shard._token = "Bot token";
  shard.presence = {};
  shard.sendWS = (opcode, payload) => payloads.push({ opcode, payload });
  shard.identify();
  return payloads[0];
}

test("supported platforms populate Identify browser and device properties exactly", () => {
  for (const platform of platforms) {
    const { payload } = identifyFor(platform);
    assert.deepEqual(payload.properties, {
      os: process.platform,
      browser: platform,
      device: platform,
    });
  }
});

test("default Identify properties remain unchanged", () => {
  const { payload } = identifyFor(undefined);
  assert.deepEqual(payload.properties, {
    os: process.platform,
    browser: "Eris",
    device: "Eris",
  });
});

test("invalid platform values are rejected by the Client constructor", () => {
  for (const platform of ["discord vr", "Discord Desktop", "", 42, null]) {
    assert.throws(() => new Eris("Bot token", { platform }), TypeError);
  }
});

test("presence statuses remain separate from platform identification", () => {
  for (const status of ["online", "idle", "dnd", "invisible"]) {
    const client = new Eris("Bot token", { platform: "Discord Web" });
    client.shards = { forEach() {} };
    client.editStatus(status);
    assert.equal(client.presence.status, status);
    assert.equal(identifyFor(client.options.platform).payload.properties.browser, "Discord Web");
  }
});

test("re-identification retains the configured platform and each shard uses it", () => {
  const platform = "Discord Embedded";
  for (const id of [0, 1, 2]) {
    const firstIdentify = identifyFor(platform, id, 3);
    const secondIdentify = identifyFor(platform, id, 3);
    assert.equal(firstIdentify.payload.properties.browser, platform);
    assert.equal(secondIdentify.payload.properties.browser, platform);
    assert.deepEqual(firstIdentify.payload.shard, [id, 3]);
  }
});

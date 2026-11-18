'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Eris = require('../');

function fixture(channels = []) {
  const client = new Eris.Client('synthetic', { intents: 0 });
  const warnings = [];
  client.on('warn', warning => warnings.push(warning));
  const shard = new Eris.Shard(0, client);
  client.shards.set(0, shard);
  const guild = client.guilds.add({ id: '1', channels }, client);
  return { client, shard, guild, warnings };
}

const shapes = [
  ['absent', {}, Eris.GuildChannel],
  ['null', { last_message_id: null }, Eris.TextChannel],
  ['message', { last_message_id: '3' }, Eris.TextChannel],
];
for (const [label, fields, ChannelClass] of shapes) {
  test(`type 20 retains ${label} fallback without repeated warnings`, () => {
    const { client, guild, warnings } = fixture();
    const data = { id: '2', guild_id: guild.id, type: 20, name: 'synthetic', parent_id: null, flags: 0, ...fields };
    const expected = new ChannelClass(data, client).toJSON();
    for (let i = 0; i < 5; i++) {
      const channel = Eris.Channel.from(data, client);
      assert.equal(channel.constructor, ChannelClass);
      assert.equal(channel.guild, guild);
      assert.deepEqual(channel.toJSON(), expected);
    }
    assert.deepEqual(warnings, []);
  });

  test(`other unknown ${label} guild types still warn`, () => {
    const { client, warnings } = fixture();
    for (const type of [987, '20']) {
      const channel = Eris.Channel.from({ id: '2', guild_id: '1', type, ...fields }, client);
      assert.equal(channel.constructor, ChannelClass);
      assert.equal(channel.type, type);
      assert.match(warnings.at(-1).message, new RegExp(`Unknown guild ${label === 'absent' ? '' : 'text '}channel type: ${type}`));
    }
    assert.equal(warnings.length, 2);
  });

  test(`guild hydration and gateway lifecycle preserve ${label} type 20 channels`, () => {
    const data = { id: '2', type: 20, name: 'initial', ...fields };
    const { client, shard, guild, warnings } = fixture([data]);
    const hydrated = guild.channels.get('2');
    assert.equal(hydrated.constructor, ChannelClass);
    assert.equal(hydrated.guild, guild);
    assert.equal(client.getChannel('2'), hydrated);
    assert.equal(client.channelGuildMap['2'], '1');
    const events = [];
    for (const event of ['channelCreate', 'channelUpdate', 'channelDelete']) {
      client.on(event, channel => events.push([event, channel]));
    }
    const dispatch = (t, d) => shard.wsEvent({ t, d: { guild_id: '1', ...d } });
    dispatch('CHANNEL_CREATE', { ...data, id: '4' });
    const created = client.getChannel('4');
    assert.equal(created.constructor, ChannelClass);
    assert.equal(created.guild, guild);
    dispatch('CHANNEL_UPDATE', { ...data, id: '4', name: 'updated' });
    assert.equal(client.getChannel('4'), created);
    assert.equal(created.name, 'updated');
    dispatch('CHANNEL_UPDATE', { id: '4', type: 0, name: 'text' });
    assert.equal(client.getChannel('4').constructor, Eris.TextChannel);
    dispatch('CHANNEL_UPDATE', { ...data, id: '4' });
    const restored = client.getChannel('4');
    assert.equal(restored.constructor, ChannelClass);
    assert.equal(restored.type, 20);
    assert.equal(client.channelGuildMap['4'], '1');
    dispatch('CHANNEL_DELETE', { id: '4', type: 20 });
    assert.equal(guild.channels.has('4'), false);
    assert.equal(client.channelGuildMap['4'], undefined);
    assert.deepEqual(events.map(([event]) => event), ['channelCreate', 'channelUpdate', 'channelUpdate', 'channelUpdate', 'channelDelete']);
    assert.equal(events[0][1], created);
    assert.equal(events.at(-1)[1], restored);
    assert.deepEqual(warnings, []);
  });
}

test('standalone type 20 retains the base fallback and warning', () => {
  const { client, warnings } = fixture();
  const channel = Eris.Channel.from({ id: '2', type: 20 }, client);
  assert.equal(channel.constructor, Eris.Channel);
  assert.equal(channel.type, 20);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Unknown channel type: 20/);
});

test('known channel types retain their classes without warnings', () => {
  const { client, warnings } = fixture();
  for (const [type, ChannelClass] of [
    [0, Eris.TextChannel], [1, Eris.DMChannel], [2, Eris.VoiceChannel],
    [3, Eris.GroupChannel], [4, Eris.CategoryChannel], [5, Eris.NewsChannel],
    [10, Eris.NewsThreadChannel], [11, Eris.PublicThreadChannel], [12, Eris.PrivateThreadChannel],
    [13, Eris.StageChannel], [15, Eris.ForumChannel], [16, Eris.MediaChannel],
  ]) {
    const channel = Eris.Channel.from({ id: '2', guild_id: '1', type, recipients: [] }, client);
    assert.equal(channel.constructor, ChannelClass);
    assert.equal(channel.type, type);
  }
  assert.deepEqual(warnings, []);
});

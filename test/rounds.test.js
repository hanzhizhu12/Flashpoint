// Topic-change rules, driven directly against the Room engine with fast timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../src/game');
const { Matcher } = require('../src/answers');
const content = require('../data/categories.json');
const elements = require('../data/elements.json');

const matcher = new Matcher(content.categories, elements);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { startMs: 150, stepMs: 10, minMs: 100, intermissionMs: 30, rejoinMs: 10000, turnsAfterBoom: 2, topicLaps: 2 };

function setup(n) {
  const events = [];
  const room = new Room({
    code: 'TEST', content, matcher, symbols: elements.map(([s]) => s), config: FAST,
    emit: (ev, data) => events.push({ ev, data }), onEmpty: () => {},
  });
  const ps = Array.from({ length: n }, (_, i) => room.addPlayer({ name: `P${i}` }));
  room.updateSettings(ps[0].id, { lives: 3 });
  room.start(ps[0].id);
  return { room, ps, events };
}
const answer = (room) => {
  const r = room.round;
  const cat = content.categories.find((c) => c.id === r.categoryId);
  const used = new Set(r.used.map((u) => u.display));
  const a = cat.answers.find((x) => !used.has(x[0]));
  room.submit(r.activeId, a[1] ?? a[0]);
};
const waitLive = async (room, notNo) => { while (room.round.status !== 'live' || room.round.no === notNo) await sleep(5); };

test('after a boil-over the topic stays for 2 more passes, then changes', async () => {
  const { room } = setup(4);
  const topic = room.round.categoryId;
  const loser = room.round.activeId;
  await sleep(FAST.startMs + 20); // fuse burns out
  assert.equal(room.round.status, 'boom');
  await waitLive(room);
  assert.equal(room.round.categoryId, topic, 'same topic after the boil-over');
  assert.equal(room.round.activeId, room.nextAlive(loser), 'next player holds it');
  assert.equal(room.round.durationMs, FAST.startMs, 'fresh fuse');
  answer(room);
  assert.equal(room.round.categoryId, topic, 'still the same topic after 1 pass');
  answer(room);
  assert.notEqual(room.round.categoryId, topic, 'new topic after 2 passes');
  room.destroy();
});

test('the topic never comes back to the player who lost a life on it', async () => {
  // 2 players: P0/P1 alternate, so after a boil-over the topic must change on the very next pass.
  const { room } = setup(2);
  const topic = room.round.categoryId;
  const loser = room.round.activeId;
  await sleep(FAST.startMs + 20);
  await waitLive(room);
  assert.equal(room.round.categoryId, topic);
  assert.notEqual(room.round.activeId, loser);
  answer(room); // would go back to the loser
  assert.equal(room.round.activeId, loser);
  assert.notEqual(room.round.categoryId, topic, 'topic changed before the loser got it back');
  room.destroy();
});

test('two boil-overs on the same topic: neither player gets it back', async () => {
  const { room } = setup(3);
  const topic = room.round.categoryId;
  const first = room.round.activeId;
  await sleep(FAST.startMs + 20);
  await waitLive(room);
  const second = room.round.activeId;
  await sleep(FAST.startMs + 20); // second player also burns out on the same topic
  await waitLive(room);
  assert.equal(room.round.categoryId, topic, 'third player still gets the topic');
  assert.deepEqual(room.round.diedOn, [first, second]);
  answer(room); // next would be `first`
  assert.notEqual(room.round.categoryId, topic);
  room.destroy();
});

test('with no boil-overs the topic changes after two laps, keeping the shrinking fuse', () => {
  const { room } = setup(3);
  const topic = room.round.categoryId;
  for (let i = 0; i < 5; i++) answer(room);
  assert.equal(room.round.categoryId, topic, 'same topic after 5 passes');
  assert.equal(room.view().round.changesIn, 1);
  answer(room); // 6th pass = 2 laps of 3 players
  assert.notEqual(room.round.categoryId, topic, 'new topic after 2 laps');
  assert.equal(room.round.durationMs, Math.max(FAST.minMs, FAST.startMs - 6 * FAST.stepMs), 'fuse keeps shrinking across the topic change');
  room.destroy();
});

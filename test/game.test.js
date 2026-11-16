// End-to-end over real sockets with short timers: joining, turns, overflow, rejoining, winning.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');

Object.assign(process.env, {
  PORT: '0', QUIET: '1', FLASK_START_MS: '1500', FLASK_STEP_MS: '200', FLASK_MIN_MS: '900', INTERMISSION_MS: '300', REJOIN_MS: '1500',
});
const { server, io, ready } = require('../server');
const content = require('../data/categories.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let URL;

class Client {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.state = null;
    this.socket = connect(URL, { forceNew: true, transports: ['websocket'] });
    this.socket.onAny((ev, data) => {
      this.events.push({ ev, data });
      if (ev === 'state') this.state = data;
      if (ev === 'joined') Object.assign(this, data);
    });
  }
  emit(ev, data = {}) { return new Promise((res) => this.socket.emit(ev, data, res)); }
  async waitFor(pred, ms = 4000, what = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred(this)) return; await sleep(15); }
    throw new Error(`${this.label}: timed out waiting for ${what}`);
  }
  waitEvent(ev, filter = () => true, ms = 5000) {
    const start = this.events.length;
    return this.waitFor((c) => c.events.slice(start).some((e) => e.ev === ev && filter(e.data)), ms, ev)
      .then(() => this.events.slice(start).find((e) => e.ev === ev && filter(e.data)).data);
  }
  close() { this.socket.close(); }
}

// Find an unused valid answer for the current category.
function validAnswer(state) {
  const cat = content.categories.find((c) => c.prompt === state.round.prompt);
  const used = new Set(state.round.used.map((u) => u.display));
  const a = cat.answers.find((x) => !used.has(x[0])); return a[1] ?? a[0];
}
const active = (clients, state) => clients.find((c) => c.playerId === state.round.activeId);

test.before(async () => { URL = `http://localhost:${await ready}`; });
test.after(() => { io.close(); server.close(); });

test('category prompts are unique (tests and players rely on them)', () => {
  const prompts = content.categories.map((c) => c.prompt);
  assert.equal(new Set(prompts).size, prompts.length);
});

test('joining, turns, overflow, rejoining and winning', async () => {
  const A = new Client('A'); const B = new Client('B'); const C = new Client('C');
  try {
    // ----- joining -----
    assert.deepEqual(await A.emit('create', { name: 'Ada', symbol: 'Au' }), { ok: true });
    await A.waitFor((c) => c.state, 2000, 'state');
    const code = A.code;
    assert.match(code, /^[A-Z]{4}$/);
    assert.equal((await B.emit('join', { code: 'ZZZZ', name: 'Bo' })).ok, false, 'bad code rejected');
    assert.equal((await B.emit('join', { code, name: 'ada' })).error, 'That nickname is taken in this room.');
    assert.match((await B.emit('join', { code, name: 'Bo', symbol: 'Xx' })).error, /isn’t an element/);
    assert.ok((await B.emit('join', { code: code.toLowerCase(), name: 'Bo', symbol: 'Ne' })).ok, 'code is case-insensitive');
    assert.ok((await C.emit('join', { code, name: 'Cy', symbol: 'Ne' })).ok, 'taken symbol falls back to a random one');
    assert.notEqual((await C.waitFor((c) => c.state.players.length === 3), C.state.players[2].symbol), 'Ne');
    assert.match((await C.emit('symbol', { symbol: 'au' })).error, /already taken/);
    await A.waitFor((c) => c.state.players.length === 3, 2000, '3 players');
    assert.equal(A.state.hostId, A.playerId);
    assert.ok(C.state.players.find((p) => p.name === 'Cy').symbol, 'C got a random element');

    // host-only settings and start
    assert.equal((await B.emit('start')).ok, false, 'only host can start');
    assert.equal((await A.emit('settings', { lives: 0 })).ok, false);
    assert.ok((await A.emit('settings', { lives: 2 })).ok);
    assert.ok((await A.emit('start')).ok);
    await A.waitFor((c) => c.state.phase === 'playing', 2000, 'playing');
    assert.ok(A.state.players.every((p) => p.lives === 2));
    const D = new Client('D');
    assert.match((await D.emit('join', { code, name: 'Di' })).error, /already started/);
    D.close();

    // ----- turns -----
    const clients = [A, B, C];
    let s = A.state;
    const holder = active(clients, s);
    const others = clients.filter((c) => c !== holder);
    // a non-holder can't answer
    others[0].socket.emit('answer', { text: validAnswer(s) });
    await sleep(100);
    assert.equal(A.state.round.used.length, 0, 'non-holder answer ignored');
    // wrong answer: shakes, flask stays
    holder.socket.emit('answer', { text: 'definitely not chemistry' });
    const rej = await A.waitEvent('rejected');
    assert.equal(rej.reason, 'wrong');
    assert.equal(A.state.round.activeId, holder.playerId);
    // valid answer: passes to the next player and shrinks the fuse
    const ans = validAnswer(s);
    holder.socket.emit('answer', { text: `  ${ans.toUpperCase()}  ` });
    const acc = await A.waitEvent('accepted');
    assert.equal(acc.playerId, holder.playerId);
    await A.waitFor((c) => c.state.round.activeId === acc.nextId && c.state.round.used.length === 1, 2000, 'pass');
    assert.notEqual(acc.nextId, holder.playerId);
    assert.equal(A.state.round.durationMs, 1300, 'fuse shrank by 200ms');
    assert.equal(B.state.round.used[0].display, acc.display, 'everyone sees the accepted answer');
    // repeated answer is rejected as used
    const next = active(clients, A.state);
    next.socket.emit('answer', { text: ans });
    assert.equal((await A.waitEvent('rejected')).reason, 'used');
    // fuse floor
    for (let i = 0; i < 4; i++) {
      const h = active(clients, A.state);
      const before = A.state.round.used.length;
      h.socket.emit('answer', { text: validAnswer(A.state) });
      await A.waitFor((c) => c.state.round.used.length === before + 1 || c.state.round.no > s.round.no, 2000, 'pass');
    }
    assert.equal(A.state.round.durationMs, 900, 'fuse never goes below the minimum');

    // ----- overflow -----
    const victimId = A.state.round.activeId;
    const roundNo = A.state.round.no;
    const boom = await A.waitEvent('boom', () => true, 3000);
    assert.equal(boom.playerId, victimId);
    assert.equal(A.state.players.find((p) => p.id === victimId).lives, 1);
    await A.waitFor((c) => c.state.round.no === roundNo + 1 && c.state.round.status === 'live', 2000, 'new round');
    const order = A.state.players.map((p) => p.id);
    assert.equal(A.state.round.activeId, order[(order.indexOf(victimId) + 1) % 3], 'next player starts the new category');
    assert.equal(A.state.round.durationMs, 1500, 'fuse resets for a new category');

    // ----- rejoining -----
    const seat = { code, token: C.token };
    const cId = C.playerId;
    C.close();
    await A.waitFor((c) => c.state.players.find((p) => p.id === cId).connected === false, 2000, 'C offline');
    const C2 = new Client('C2');
    assert.ok((await C2.emit('rejoin', seat)).ok);
    assert.equal(C2.playerId, cId, 'same seat after rejoin');
    await A.waitFor((c) => c.state.players.find((p) => p.id === cId).connected, 2000, 'C back');
    const X = new Client('X');
    assert.equal((await X.emit('rejoin', { code, token: 'nope' })).ok, false, 'bad token refused');
    X.close();

    // ----- winning (B drops out for good; A and C2 let fuses burn) -----
    const bId = B.playerId;
    B.close();
    await sleep(1700); // past the rejoin window
    assert.equal(A.state.players.find((p) => p.id === bId).lives, 0, 'B eliminated after grace period');
    const over = await A.waitEvent('gameover', () => true, 15000);
    assert.ok(over.winnerId, 'there is a winner');
    assert.equal(A.state.phase, 'results');
    const alive = A.state.players.filter((p) => p.lives > 0);
    assert.deepEqual(alive.map((p) => p.id), [over.winnerId]);
    assert.equal(A.state.players.find((p) => p.id === over.winnerId).wins, 1);

    // ----- rematch -----
    const host = [A, C2].find((c) => c.playerId === A.state.hostId);
    assert.ok((await host.emit('rematch')).ok);
    await A.waitFor((c) => c.state.phase === 'playing', 2000, 'rematch');
    assert.equal(A.state.players.length, 2, 'player who left is gone from the rematch');
    assert.ok(A.state.players.every((p) => p.lives === 2));
    C2.close();
  } finally {
    A.close(); B.close(); C.close();
  }
});

test('host leaving hands the room over; empty rooms are deleted', async () => {
  const { rooms } = require('../server');
  const A = new Client('A'); const B = new Client('B');
  await A.emit('create', { name: 'Host' });
  await A.waitFor((c) => c.code, 1000, 'code');
  await B.emit('join', { code: A.code, name: 'Guest' });
  await B.waitFor((c) => c.state && c.state.players.length === 2, 1000, 'join');
  await A.emit('leave');
  await B.waitFor((c) => c.state.players.length === 1 && c.state.hostId === c.playerId, 2000, 'host handover');
  B.close();
  await sleep(1700);
  assert.equal(rooms.has(A.code), false, 'room cleaned up');
  A.close();
});

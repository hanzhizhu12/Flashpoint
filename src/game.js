// Room + game state machine. Pure logic: the server wires `emit` to Socket.io.
const crypto = require('crypto');

const DEFAULTS = {
  startMs: 15000, // flask fuse at the start of a round
  stepMs: 1000, // shrink per successful pass
  minMs: 6000,
  intermissionMs: 3500, // pause after a boil-over before the next category
  rejoinMs: 30000, // grace period for disconnected players
  maxPlayers: 8,
};

const MAX_LIVES = 9;
const randomId = (n = 12) => crypto.randomBytes(n).toString('base64url');

class Room {
  /**
   * @param {object} o
   * @param {string} o.code
   * @param {object} o.content   { levels, categories }
   * @param {Matcher} o.matcher
   * @param {string[]} o.symbols valid element symbols for avatars
   * @param {(event:string, payload:any, to?:string)=>void} o.emit  to = player id for private messages
   * @param {()=>void} o.onEmpty called when the room should be deleted
   */
  constructor({ code, content, matcher, symbols, emit, onEmpty, config = {} }) {
    this.code = code;
    this.content = content;
    this.matcher = matcher;
    this.symbols = symbols;
    this.emit = emit;
    this.onEmpty = onEmpty;
    this.cfg = { ...DEFAULTS, ...config };
    this.players = []; // turn order = join order
    this.hostId = null;
    this.phase = 'lobby'; // lobby | playing | results
    this.settings = { lives: 3, level: content.levels[0].id };
    this.round = null;
    this.winnerId = null;
    this.bag = [];
    this.timer = null;
    this.feed = []; // recent events shown in the game log
  }

  // ---------- players ----------
  validateName(name) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!n) throw new Error('Pick a nickname.');
    if (this.players.some((p) => p.name.toLowerCase() === n.toLowerCase())) throw new Error('That nickname is taken in this room.');
    return n;
  }

  pickSymbol(wanted, selfId, fallback = false) {
    const want = String(wanted || '').trim();
    const sym = this.symbols.find((s) => s.toLowerCase() === want.toLowerCase());
    const taken = new Set(this.players.filter((p) => p.id !== selfId).map((p) => p.symbol));
    if (want && !sym) throw new Error(`“${want}” isn’t an element symbol.`);
    if (sym && taken.has(sym) && !fallback) throw new Error(`${sym} is already taken.`);
    if (sym && !taken.has(sym)) return sym;
    const free = this.symbols.slice(0, 54).filter((s) => !taken.has(s));
    return free[Math.floor(Math.random() * free.length)];
  }

  addPlayer({ name, symbol }) {
    if (this.phase !== 'lobby') throw new Error('That game has already started.');
    if (this.players.length >= this.cfg.maxPlayers) throw new Error('Room is full (8 players max).');
    const player = {
      id: randomId(6),
      token: randomId(18),
      name: this.validateName(name),
      symbol: this.pickSymbol(symbol, null, true), // taken on join → random free element (changeable in the lobby)
      lives: 0,
      connected: true,
      dropTimer: null,
      wins: 0,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    this.log(`${player.name} joined`);
    this.broadcast();
    return player;
  }

  byId(id) { return this.players.find((p) => p.id === id); }
  byToken(token) { return this.players.find((p) => p.token === token); }

  setSymbol(id, symbol) {
    if (this.phase === 'playing') throw new Error('Can’t change element mid-game.');
    const p = this.byId(id);
    p.symbol = this.pickSymbol(symbol, id);
    this.broadcast();
  }

  disconnect(id) {
    const p = this.byId(id);
    if (!p || !p.connected) return;
    p.connected = false;
    this.log(`${p.name} disconnected — 30s to rejoin`);
    clearTimeout(p.dropTimer);
    p.dropTimer = setTimeout(() => this.expire(id), this.cfg.rejoinMs);
    this.reassignHost();
    this.broadcast();
  }

  reconnect(id) {
    const p = this.byId(id);
    if (!p) return null;
    clearTimeout(p.dropTimer);
    p.dropTimer = null;
    p.gone = false; // back (possibly as a spectator if eliminated) — keep them for the rematch
    if (!p.connected) {
      p.connected = true;
      this.log(`${p.name} rejoined`);
    }
    if (!this.byId(this.hostId)?.connected) this.hostId = p.id;
    this.broadcast();
    return p;
  }

  leave(id) {
    const p = this.byId(id);
    if (!p) return;
    clearTimeout(p.dropTimer);
    p.connected = false;
    this.expire(id, true);
  }

  // Grace period ran out (or player left on purpose).
  expire(id, voluntary = false) {
    const p = this.byId(id);
    if (!p || (p.connected && !voluntary)) return;
    clearTimeout(p.dropTimer);
    p.dropTimer = null; // no longer "inside the grace period"
    p.gone = true;
    this.log(voluntary ? `${p.name} left` : `${p.name} didn’t make it back`);
    if (this.phase === 'playing' && p.lives > 0) {
      p.lives = 0;
      const wasActive = this.round && this.round.activeId === id;
      if (this.aliveCount() <= 1) return this.finish();
      if (wasActive && this.round.status === 'live') {
        clearTimeout(this.timer);
        this.startRound(this.nextAlive(id));
        return;
      }
    }
    if (this.phase !== 'playing') this.players = this.players.filter((x) => x.id !== id);
    if (!this.players.some((x) => x.connected)) return this.destroy();
    this.reassignHost();
    this.broadcast();
  }

  reassignHost() {
    if (this.byId(this.hostId)?.connected) return;
    const next = this.players.find((p) => p.connected);
    if (next) this.hostId = next.id;
  }

  destroy() {
    clearTimeout(this.timer);
    for (const p of this.players) clearTimeout(p.dropTimer);
    this.players = [];
    this.onEmpty?.();
  }

  // ---------- settings / flow ----------
  updateSettings(id, { lives, level }) {
    this.requireHost(id);
    if (this.phase === 'playing') throw new Error('Game in progress.');
    if (lives !== undefined) {
      const n = Math.round(Number(lives));
      if (!(n >= 1 && n <= MAX_LIVES)) throw new Error(`Lives must be 1–${MAX_LIVES}.`);
      this.settings.lives = n;
    }
    if (level !== undefined) {
      if (!this.content.levels.some((l) => l.id === level)) throw new Error('Unknown difficulty.');
      this.settings.level = level;
      this.bag = [];
    }
    this.broadcast();
  }

  requireHost(id) {
    if (id !== this.hostId) throw new Error('Only the host can do that.');
  }

  start(id) {
    this.requireHost(id);
    if (this.phase === 'playing') throw new Error('Already playing.');
    this.players = this.players.filter((p) => !p.gone); // keep people still inside their grace period
    const ready = this.players.filter((p) => p.connected);
    if (ready.length < 2) throw new Error('Need at least 2 players.');
    for (const p of this.players) p.lives = this.settings.lives;
    this.phase = 'playing';
    this.winnerId = null;
    this.feed = [];
    this.log(`Game on! ${this.settings.lives} ${this.settings.lives === 1 ? 'life' : 'lives'} each`);
    const first = this.players[Math.floor(Math.random() * this.players.length)];
    this.startRound(first.id);
  }

  toLobby(id) {
    this.requireHost(id);
    if (this.phase !== 'results') throw new Error('Game in progress.');
    this.phase = 'lobby';
    this.round = null;
    this.players = this.players.filter((p) => !p.gone);
    this.broadcast();
  }

  // ---------- rounds ----------
  drawCategory() {
    if (!this.bag.length) {
      const pool = this.content.categories.filter((c) => c.levels.includes(this.settings.level));
      this.bag = pool.map((c) => c.id).sort(() => Math.random() - 0.5);
    }
    const id = this.bag.pop();
    return this.content.categories.find((c) => c.id === id);
  }

  aliveCount() { return this.players.filter((p) => p.lives > 0).length; }

  nextAlive(fromId) {
    const n = this.players.length;
    const i = this.players.findIndex((p) => p.id === fromId);
    for (let k = 1; k <= n; k++) {
      const p = this.players[(i + k + n) % n];
      if (p.lives > 0) return p.id;
    }
    return null;
  }

  startRound(activeId) {
    const active = this.byId(activeId);
    if (!active || active.lives <= 0) activeId = this.nextAlive(activeId);
    const cat = this.drawCategory();
    this.round = {
      no: (this.round?.no || 0) + 1,
      categoryId: cat.id,
      prompt: cat.prompt,
      source: cat.source,
      total: cat.answers.length,
      used: [], // { index, display, by }
      activeId,
      durationMs: this.cfg.startMs,
      deadline: 0,
      status: 'live', // live | boom
      passes: 0,
    };
    this.log(`New category: ${cat.prompt}`);
    this.armTimer(this.cfg.startMs);
    this.emit('round', { prompt: cat.prompt, activeId });
    this.broadcast();
  }

  armTimer(ms) {
    clearTimeout(this.timer);
    this.round.durationMs = ms;
    this.round.deadline = Date.now() + ms;
    this.timer = setTimeout(() => this.boom(), ms);
  }

  submit(id, text) {
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.status !== 'live') return;
    if (r.activeId !== id) return; // only the flask holder can answer
    const raw = String(text || '').slice(0, 60).trim();
    if (!raw) return;
    const player = this.byId(id);
    const m = this.matcher.match(r.categoryId, raw);
    if (!m) {
      this.emit('rejected', { playerId: id, text: raw, reason: 'wrong' });
      return;
    }
    if (r.used.some((u) => u.index === m.index)) {
      this.emit('rejected', { playerId: id, text: raw, reason: 'used', display: m.display });
      return;
    }
    r.used.push({ index: m.index, display: m.display, by: id, typo: m.typo });
    r.passes++;
    this.log(`${player.name}: ${m.display}`);
    const nextId = this.nextAlive(id);
    this.emit('accepted', { playerId: id, nextId, text: raw, display: m.display, typo: m.typo });
    if (r.used.length >= r.total) {
      // Every answer used up: fresh category, no penalty.
      this.log('Category cleared! Fresh flask.');
      this.startRound(nextId);
      return;
    }
    r.activeId = nextId;
    this.armTimer(Math.max(this.cfg.minMs, r.durationMs - this.cfg.stepMs));
    this.broadcast();
  }

  boom() {
    const r = this.round;
    if (!r || r.status !== 'live') return;
    r.status = 'boom';
    const loser = this.byId(r.activeId);
    loser.lives = Math.max(0, loser.lives - 1);
    this.log(loser.lives ? `${loser.name}’s flask boiled over! (${loser.lives} left)` : `${loser.name}’s flask boiled over — eliminated!`);
    this.emit('boom', { playerId: loser.id, livesLeft: loser.lives });
    this.broadcast();
    this.timer = setTimeout(() => {
      if (this.phase !== 'playing') return;
      if (this.aliveCount() <= 1) return this.finish();
      this.startRound(this.nextAlive(loser.id));
    }, this.cfg.intermissionMs);
  }

  finish() {
    clearTimeout(this.timer);
    this.phase = 'results';
    const alive = this.players.filter((p) => p.lives > 0);
    const winner = alive.length === 1 ? alive[0] : null;
    this.winnerId = winner?.id || null;
    if (winner) { winner.wins++; this.log(`${winner.name} wins!`); }
    if (this.round) this.round.status = 'over';
    this.emit('gameover', { winnerId: this.winnerId });
    this.broadcast();
    if (!this.players.some((p) => p.connected)) this.destroy();
  }

  // ---------- views ----------
  log(text) {
    this.feed.push({ t: Date.now(), text });
    if (this.feed.length > 30) this.feed.shift();
  }

  view() {
    const r = this.round;
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      levels: this.content.levels.map(({ id, name }) => ({ id, name })),
      winnerId: this.winnerId,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, symbol: p.symbol, lives: p.lives, connected: p.connected, wins: p.wins,
      })),
      round: r && {
        no: r.no, prompt: r.prompt, source: r.source, total: r.total, used: r.used.map(({ display, by, typo }) => ({ display, by, typo })),
        activeId: r.activeId, durationMs: r.durationMs, remainingMs: Math.max(0, r.deadline - Date.now()), status: r.status,
      },
      feed: this.feed.slice(-8),
    };
  }

  broadcast() { this.emit('state', this.view()); }
}

module.exports = { Room, DEFAULTS, MAX_LIVES };

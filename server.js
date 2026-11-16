const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./src/game');
const { Matcher } = require('./src/answers');

const content = require('./data/categories.json');
const elements = require('./data/elements.json');
const matcher = new Matcher(content.categories, elements);
const symbols = elements.map(([s]) => s);

// Optional overrides (used by tests): FLASK_START_MS, FLASK_STEP_MS, FLASK_MIN_MS, INTERMISSION_MS, REJOIN_MS
const envMs = (k) => (process.env[k] ? Number(process.env[k]) : undefined);
const config = Object.fromEntries(Object.entries({
  startMs: envMs('FLASK_START_MS'), stepMs: envMs('FLASK_STEP_MS'), minMs: envMs('FLASK_MIN_MS'),
  intermissionMs: envMs('INTERMISSION_MS'), rejoinMs: envMs('REJOIN_MS'),
}).filter(([, v]) => v !== undefined));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/elements.json', (_req, res) => res.json(elements));
app.get('/healthz', (_req, res) => res.send('ok'));

/** @type {Map<string, Room>} */
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid 1/0 confusion

function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
    if (!rooms.has(code)) return code;
  }
}

function createRoom() {
  const code = newCode();
  const room = new Room({
    code, content, matcher, symbols, config,
    emit: (event, payload) => io.to(code).emit(event, payload),
    onEmpty: () => rooms.delete(code),
  });
  rooms.set(code, room);
  return room;
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const attach = (r, p) => {
    room = r; me = p;
    p.socketId = socket.id; // the seat's current socket; older sockets for it are ignored
    socket.data.token = p.token;
    socket.join(r.code);
    socket.emit('joined', { code: r.code, playerId: p.id, token: p.token });
    r.broadcast();
  };

  // Wrap handlers: errors go back to the caller as a toast.
  const on = (event, fn) => socket.on(event, (data = {}, ack) => {
    try {
      fn(data || {});
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
      else socket.emit('oops', err.message);
    }
  });
  const needRoom = () => { if (!room || !me || !room.byId(me.id)) throw new Error('You’re not in a room.'); };

  on('create', ({ name, symbol }) => {
    if (room) throw new Error('Already in a room.');
    const r = createRoom();
    try { attach(r, r.addPlayer({ name, symbol })); } catch (e) { rooms.delete(r.code); throw e; }
  });

  on('join', ({ code, name, symbol }) => {
    if (room) throw new Error('Already in a room.');
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) throw new Error('No room with that code.');
    attach(r, r.addPlayer({ name, symbol }));
  });

  on('rejoin', ({ code, token }) => {
    const r = rooms.get(String(code || '').toUpperCase());
    const p = r && r.byToken(token);
    if (!p) throw new Error('That game is gone.');
    // Kick any older socket still holding this seat.
    for (const s of io.sockets.sockets.values()) if (s !== socket && s.data.token === token) s.disconnect(true);
    r.reconnect(p.id);
    attach(r, p);
  });

  on('symbol', ({ symbol }) => { needRoom(); room.setSymbol(me.id, symbol); });
  on('settings', (s) => { needRoom(); room.updateSettings(me.id, s); });
  on('start', () => { needRoom(); room.start(me.id); });
  on('answer', ({ text }) => {
    needRoom();
    const now = Date.now(); // light flood guard: 8 tries per second
    socket.data.hits = (socket.data.hits || []).filter((t) => now - t < 1000);
    if (socket.data.hits.length >= 8) return;
    socket.data.hits.push(now);
    room.submit(me.id, text);
  });
  on('rematch', () => { needRoom(); room.start(me.id); });
  on('lobby', () => { needRoom(); room.toLobby(me.id); });
  on('leave', () => {
    if (room && me) { room.leave(me.id); socket.leave(room.code); }
    room = null; me = null;
  });

  socket.on('disconnect', () => {
    const p = room && me && room.byId(me.id);
    if (p && p.socketId === socket.id) room.disconnect(me.id);
  });
});

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
const ready = new Promise((resolve) => {
  server.listen(PORT, () => {
    const { port } = server.address();
    if (!process.env.QUIET) console.log(`Flashpoint running on http://localhost:${port}`);
    resolve(port);
  });
});

module.exports = { server, io, rooms, ready };

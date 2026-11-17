/* global io, Sound */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mkStore = (area) => ({
    get(k) { try { return JSON.parse(window[area].getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { window[area].setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
    del(k) { try { window[area].removeItem(k); } catch (_) { /* ignore */ } },
  });
  const store = mkStore('localStorage'); // profile + "last game" (shared by tabs)
  const tab = mkStore('sessionStorage'); // this tab's seat: survives reloads, never collides with other tabs
  const SESSION = 'flashpoint.session';
  const LAST = 'flashpoint.last';
  const PROFILE = 'flashpoint.profile';
  const COLORS = ['#39ff88', '#ff3cac', '#2de2ff', '#ffc93c', '#b26bff', '#ff7a1a', '#c6ff3c', '#ff6b6b'];
  const START_MS = 15000;

  // ---------- element data ----------
  const ELEMENTS = new Map(); // symbol -> { num, name }
  let SYMBOLS = [];
  fetch('/elements.json').then((r) => r.json()).then((list) => {
    list.forEach(([sym, name], i) => ELEMENTS.set(sym, { num: i + 1, name }));
    SYMBOLS = list.map(([s]) => s);
    if (!$('#symbolInput').value) randomSymbol(); else updateAvatarPreview();
    if (S) render();
  });
  const findSymbol = (s) => SYMBOLS.find((x) => x.toLowerCase() === String(s || '').trim().toLowerCase());

  function tileHTML(sym, color, extra = '') {
    const el = ELEMENTS.get(sym) || { num: '', name: '' };
    return `<div class="tile ${extra}" style="--c:${color}"><span class="num">${el.num}</span><span class="sym">${esc(sym || '?')}</span><span class="nm">${esc(el.name)}</span></div>`;
  }

  // ---------- state ----------
  const socket = io();
  let S = null; // latest room view from the server
  let me = null; // my player id
  let localDeadline = 0;
  let lastRoundNo = 0;
  let lastUsed = 0;
  let wasMyTurn = false;
  let lastTickSec = null;
  let requestedSymbol = null; // to tell the player if their element was already taken

  const colorOf = (id) => {
    const i = S ? S.players.findIndex((p) => p.id === id) : 0;
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  };
  const playerById = (id) => S && S.players.find((p) => p.id === id);
  const nameOf = (id) => (playerById(id) || {}).name || '???';

  // ---------- screens ----------
  function show(name) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    $('#leaveBtn').classList.toggle('hidden', name === 'home');
  }

  function toast(msg, err = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 3300);
  }

  // ---------- home ----------
  const profile = store.get(PROFILE) || {};
  $('#nameInput').value = profile.name || '';
  $('#symbolInput').value = profile.symbol || '';
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#codeInput').value = params.get('room').toUpperCase().slice(0, 4);

  function updateAvatarPreview() {
    const sym = findSymbol($('#symbolInput').value);
    const el = sym ? ELEMENTS.get(sym) : null;
    $('#avatarPreview').innerHTML = `<span class="num">${el ? el.num : ''}</span><span class="sym">${esc(sym || '?')}</span><span class="nm">${el ? esc(el.name) : 'pick one'}</span>`;
    $('#avatarPreview').style.setProperty('--c', sym ? COLORS[(el.num * 7) % COLORS.length] : 'rgba(238,243,234,.3)');
  }
  function randomSymbol() {
    const pool = SYMBOLS.slice(0, 86);
    $('#symbolInput').value = pool[Math.floor(Math.random() * pool.length)] || 'Au';
    updateAvatarPreview();
  }
  $('#symbolInput').addEventListener('input', updateAvatarPreview);
  $('#randomSym').addEventListener('click', randomSymbol);
  $('#avatarPreview').addEventListener('click', randomSymbol);
  $('#codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

  function readProfile() {
    const name = $('#nameInput').value.trim();
    const symbol = $('#symbolInput').value.trim();
    if (!name) { toast('Pick a nickname first.', true); $('#nameInput').focus(); return null; }
    if (symbol && SYMBOLS.length && !findSymbol(symbol)) { toast(`“${symbol}” isn’t an element symbol.`, true); return null; }
    store.set(PROFILE, { name, symbol: findSymbol(symbol) || '' });
    requestedSymbol = findSymbol(symbol) || '';
    return { name, symbol: findSymbol(symbol) || '' };
  }
  const ack = (r) => { if (r && !r.ok) toast(r.error, true); };

  $('#createBtn').addEventListener('click', () => {
    const p = readProfile();
    if (p) socket.emit('create', p, ack);
  });
  function join() {
    const p = readProfile();
    const code = $('#codeInput').value.trim().toUpperCase();
    if (!p) return;
    if (code.length !== 4) { toast('Room codes are 4 letters.', true); $('#codeInput').focus(); return; }
    socket.emit('join', { ...p, code }, ack);
  }
  $('#joinBtn').addEventListener('click', join);
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } });
  $('#profileForm').addEventListener('submit', (e) => { e.preventDefault(); if ($('#codeInput').value.length === 4) join(); else $('#createBtn').click(); });

  // ---------- connection ----------
  socket.on('connect', () => {
    const sess = tab.get(SESSION);
    if (sess && sess.code && sess.token) rejoin(sess);
    else showRejoinOffer();
  });
  socket.on('disconnect', () => { if (S) toast('Connection lost — reconnecting…', true); });

  function rejoin(sess) {
    socket.emit('rejoin', sess, (r) => {
      if (r.ok) return;
      tab.del(SESSION); store.del(LAST); me = null; S = null; show('home'); showRejoinOffer();
      toast('That game has ended.');
    });
  }
  // A closed tab loses sessionStorage; offer the last seat from localStorage instead (10 min).
  function showRejoinOffer() {
    const last = store.get(LAST);
    const btn = $('#rejoinBtn');
    if (last && Date.now() - last.t < 10 * 60 * 1000 && !me) {
      btn.textContent = `Rejoin room ${last.code} as ${last.name}`;
      btn.classList.remove('hidden');
      btn.onclick = () => rejoin({ code: last.code, token: last.token });
    } else btn.classList.add('hidden');
  }

  socket.on('joined', ({ code, playerId, token }) => {
    me = playerId;
    tab.set(SESSION, { code, token });
    $('#rejoinBtn').classList.add('hidden');
    history.replaceState(null, '', `?room=${code}`);
  });

  socket.on('state', (state) => {
    S = state;
    const mine = me && S.players.find((p) => p.id === me);
    if (me && !mine) { // dropped from the room
      tab.del(SESSION); store.del(LAST); me = null; S = null; show('home'); return;
    }
    if (mine && requestedSymbol !== null) {
      if (requestedSymbol && mine.symbol !== requestedSymbol) toast(`${requestedSymbol} was taken, so you’re ${mine.symbol}. Tap your tile to change it.`);
      requestedSymbol = null;
    }
    if (mine) { const sess = tab.get(SESSION); if (sess) store.set(LAST, { ...sess, name: mine.name, t: Date.now() }); }
    render();
  });
  socket.on('oops', (msg) => toast(msg, true));

  // ---------- lobby ----------
  $('#roomCode').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${S.code}`;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Flashpoint', text: `Join my Flashpoint room: ${S.code}`, url });
      else { await navigator.clipboard.writeText(url); $('#copyHint').textContent = 'Link copied!'; setTimeout(() => { $('#copyHint').textContent = 'Tap to copy invite link'; }, 1600); }
    } catch (_) { /* share cancelled */ }
  });
  $$('[data-lives]').forEach((b) => b.addEventListener('click', () => {
    socket.emit('settings', { lives: S.settings.lives + Number(b.dataset.lives) }, ack);
  }));
  $('#startBtn').addEventListener('click', () => socket.emit('start', {}, ack));

  function changeMySymbol() {
    const next = window.prompt('Pick your element symbol (e.g. Au, Ne, Fe):', playerById(me)?.symbol || '');
    if (next) socket.emit('symbol', { symbol: next.trim() }, ack);
  }

  function renderLobby() {
    const isHost = S.hostId === me;
    $('#roomCode').textContent = S.code;
    const connected = S.players.filter((p) => p.connected).length;
    $('#playerCount').textContent = `${S.players.length}/8`;
    const cells = S.players.map((p) => {
      const cls = ['player-cell', p.id === me ? 'me' : '', p.connected ? '' : 'offline'].join(' ');
      const tile = tileHTML(p.symbol, colorOf(p.id));
      return `<div class="${cls}">${p.id === me ? `<button class="tile-btn" data-change-sym aria-label="Change your element">${tile}</button>` : tile}
        <span class="player-name">${esc(p.name)}${p.id === me ? ' (you)' : ''}</span>${p.id === S.hostId ? '<span class="badge">host</span>' : ''}</div>`;
    });
    if (S.players.length < 8) cells.push(`<div class="player-cell empty">${tileHTML('?', 'transparent')}<span class="player-name">waiting…</span></div>`);
    $('#lobbyPlayers').innerHTML = cells.join('');
    $('[data-change-sym]')?.addEventListener('click', changeMySymbol);

    $('#hostSettings').classList.toggle('hidden', !isHost);
    $('#guestSettings').classList.toggle('hidden', isHost);
    const level = S.levels.find((l) => l.id === S.settings.level);
    $('#guestSettings').textContent = `${S.settings.lives} ${S.settings.lives === 1 ? 'life' : 'lives'} · ${level ? level.name : ''}`;
    $('#livesOut').textContent = S.settings.lives;
    $('#levelPicker').innerHTML = S.levels.map((l) => `<button type="button" role="radio" aria-checked="${l.id === S.settings.level}" data-level="${esc(l.id)}">${esc(l.name)}</button>`).join('');
    $$('[data-level]').forEach((b) => b.addEventListener('click', () => socket.emit('settings', { level: b.dataset.level }, ack)));
    $('#startBtn').classList.toggle('hidden', !isHost);
    $('#startBtn').disabled = connected < 2;
    $('#startBtn').textContent = connected < 2 ? 'Need 2+ players' : 'Start reaction';
    $('#waitMsg').classList.toggle('hidden', isHost);
  }

  // ---------- game ----------
  const flaskWrap = $('#flaskWrap');
  const liquid = document.querySelector('.liquid');
  const bubblesG = $('#bubbles');
  const input = $('#answerInput');
  let bubbles = [];

  function renderGame() {
    const r = S.round;
    if (!r) return;
    const mine = r.activeId === me && r.status === 'live';

    if (r.no !== lastRoundNo) {
      lastRoundNo = r.no; lastUsed = 0;
      $('#promptText').classList.remove('fresh'); void $('#promptText').offsetWidth; $('#promptText').classList.add('fresh');
      $('#attempt').innerHTML = '';
    }
    $('#promptText').textContent = r.prompt;
    $('#roundNo').textContent = r.changesIn == null ? `Topic ${r.no}`
      : r.changesIn <= 1 ? `Topic ${r.no} · last pass` : `Topic ${r.no} · ${r.changesIn} passes left`;
    $('#roundNo').classList.toggle('warn', r.diedOn.length > 0);
    $('#promptSource').textContent = r.source ? `Textbook: ${r.source}` : '';

    // seats
    $('#ring').innerHTML = S.players.map((p) => {
      const cls = ['seat', p.id === r.activeId && r.status !== 'over' ? 'active' : '', p.lives <= 0 ? 'out' : '', p.connected ? '' : 'offline'].join(' ');
      const lives = Array.from({ length: S.settings.lives }, (_, i) => `<i class="life ${i < p.lives ? '' : 'gone'}"></i>`).join('');
      return `<div class="${cls}" data-seat="${p.id}" style="--c:${colorOf(p.id)}">${tileHTML(p.symbol, colorOf(p.id))}
        <span class="player-name">${esc(p.name)}</span><span class="lives" aria-label="${p.lives} lives">${lives}</span></div>`;
    }).join('');
    $(`[data-seat="${r.activeId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

    // used answers
    $('#usedCount').textContent = `${r.used.length}/${r.total}`;
    $('#usedList').innerHTML = r.used.map((u, i) => {
      const p = playerById(u.by);
      return `<li class="${i >= lastUsed ? 'new' : ''}" style="--c:${colorOf(u.by)}"><span class="who">${esc(p ? p.symbol : '?')}</span>${esc(u.display)}${u.typo ? ' <span class="typo">(close enough)</span>' : ''}</li>`;
    }).join('');
    lastUsed = r.used.length;

    // timer + turn
    if (r.status === 'live') localDeadline = performance.now() + r.remainingMs;
    const holder = playerById(r.activeId);
    const turn = $('#turnText');
    turn.classList.toggle('mine', mine);
    if (r.status === 'boom') turn.textContent = `${holder ? holder.name : 'Someone'}’s flask boiled over!`;
    else if (mine && r.diedOn.length && r.used.length && r.durationMs === START_MS) turn.textContent = 'Same topic, fresh flask. Your turn!';
    else if (r.status === 'over') turn.textContent = 'Reaction complete!';
    else turn.textContent = mine ? 'Your flask! Name one!' : `${holder ? holder.name : '…'} is holding the flask`;

    $('#answerForm').classList.toggle('waiting', !mine);
    input.placeholder = mine ? 'Type an answer…' : 'Get ready… (you can type ahead)';
    if (mine && !wasMyTurn) {
      if (matchMedia('(pointer: fine)').matches) input.focus();
      navigator.vibrate?.(40);
    }
    wasMyTurn = mine;

    flaskWrap.classList.toggle('idle', r.status !== 'live');
    if (r.status === 'live') Sound.startBubbling(); else Sound.stopBubbling();
  }

  $('#answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !S || !S.round) return;
    if (S.round.activeId !== me || S.round.status !== 'live') {
      $('#attempt').innerHTML = '<span class="dup">Not your flask yet. Hold that thought!</span>';
      return;
    }
    socket.emit('answer', { text });
  });

  socket.on('accepted', ({ playerId, nextId, display, typo }) => {
    Sound.pass();
    $('#attempt').innerHTML = `<span class="good">✓ ${esc(nameOf(playerId))}: ${esc(display)}${typo ? ' (close enough!)' : ''}</span>`;
    if (playerId === me) input.value = '';
    if (nextId === me) navigator.vibrate?.(40);
  });

  socket.on('rejected', ({ playerId, text, reason, display }) => {
    flaskWrap.classList.remove('jolt'); void flaskWrap.offsetWidth; flaskWrap.classList.add('jolt');
    setTimeout(() => flaskWrap.classList.remove('jolt'), 460);
    const who = playerId === me ? '' : `${esc(nameOf(playerId))}: `;
    $('#attempt').innerHTML = reason === 'used'
      ? `<span class="dup">↺ ${who}${esc(display)} was already used</span>`
      : `${who}<span class="bad">${esc(text)}</span>`;
    if (playerId === me) { reason === 'used' ? Sound.used() : Sound.wrong(); input.select(); }
  });

  socket.on('boom', ({ playerId }) => {
    Sound.stopBubbling();
    Sound.fizz();
    flaskWrap.classList.remove('boom'); void flaskWrap.offsetWidth; flaskWrap.classList.add('boom');
    setTimeout(() => flaskWrap.classList.remove('boom'), 2200);
    spawnFoam();
    const seat = $(`[data-seat="${playerId}"]`);
    seat?.classList.add('hit');
    if (playerId === me) navigator.vibrate?.([80, 40, 160]);
  });
  socket.on('round', () => Sound.round());
  socket.on('resume', () => Sound.round());
  socket.on('gameover', () => setTimeout(() => Sound.win(), 600));

  function spawnFoam() {
    const foam = $('#foam');
    const w = foam.clientWidth;
    for (let i = 0; i < 28; i++) {
      const s = document.createElement('span');
      const size = 16 + Math.random() * 34;
      s.style.width = s.style.height = `${size}px`;
      s.style.left = `${w / 2 - size / 2 + (Math.random() - 0.5) * 20}px`;
      s.style.top = `${4 + Math.random() * 6}%`;
      s.style.setProperty('--dx', `${(Math.random() - 0.5) * w * 1.3}px`);
      s.style.setProperty('--dy', `${-30 + Math.random() * w * 0.9}px`);
      s.style.animationDelay = `${Math.random() * 0.35}s`;
      foam.appendChild(s);
      setTimeout(() => s.remove(), 2500);
    }
  }

  // Animation loop: liquid colour/level, bubbles, shake amplitude, timer bar.
  const root = document.documentElement;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!S || S.phase !== 'playing' || !S.round) return;
    const r = S.round;
    let heat;
    let frac;
    if (r.status === 'live') {
      const rem = Math.max(0, localDeadline - now);
      frac = rem / r.durationMs;
      heat = Math.min(1, Math.max(0, 1 - rem / START_MS));
      const sec = Math.ceil(rem / 1000);
      $('#timerNum').textContent = sec;
      if (sec !== lastTickSec && sec <= 3 && sec > 0) Sound.tick();
      lastTickSec = sec;
    } else {
      frac = 0; heat = r.status === 'boom' ? 1 : 0;
      $('#timerNum').textContent = '0';
    }
    Sound.setHeat(heat);
    const hue = (140 - heat * 170 + 360) % 360; // green → yellow → orange → hot pink
    root.style.setProperty('--liquid', `hsl(${hue} 100% ${58 + heat * 4}%)`);
    root.style.setProperty('--heat', heat.toFixed(3));
    root.style.setProperty('--amp', (0.4 + heat * heat * 6).toFixed(2));
    $('#timerBar').style.transform = `scaleX(${frac})`;
    const level = 160 - heat * 85; // liquid rises as it heats
    liquid.setAttribute('transform', `translate(0 ${level - 120})`);

    // bubbles
    if (r.status === 'live' && Math.random() < 0.08 + heat * 0.5) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const x = 55 + Math.random() * 90;
      const b = { el: c, x, y: 222, r: 2 + Math.random() * (3 + heat * 5), v: 0.6 + Math.random() * 0.8 + heat * 2.4, wob: Math.random() * 6 };
      c.setAttribute('r', b.r.toFixed(1));
      bubblesG.appendChild(c);
      bubbles.push(b);
    }
    bubbles = bubbles.filter((b) => {
      b.y -= b.v;
      const x = b.x + Math.sin((b.y + b.wob * 20) / 9) * 2;
      b.el.setAttribute('cx', x.toFixed(1));
      b.el.setAttribute('cy', b.y.toFixed(1));
      if (b.y < level - 2) { b.el.remove(); return false; }
      return true;
    });
  }
  requestAnimationFrame(frame);

  // ---------- results ----------
  $('#rematchBtn').addEventListener('click', () => socket.emit('rematch', {}, ack));
  $('#toLobbyBtn').addEventListener('click', () => socket.emit('lobby', {}, ack));

  function renderResults() {
    const isHost = S.hostId === me;
    const w = playerById(S.winnerId);
    $('#winnerBox').innerHTML = w
      ? `${tileHTML(w.symbol, colorOf(w.id))}<span class="wname">${esc(w.name)} wins!</span>`
      : '<span class="wname">No survivors…</span>';
    $('#resultTitle').textContent = w && w.id === me ? 'You win! 🧪' : 'Reaction complete!';
    const ranked = [...S.players].sort((a, b) => (b.lives - a.lives) || (b.wins - a.wins));
    $('#standings').innerHTML = ranked.map((p, i) => `<li><span class="place">${i + 1}</span>${tileHTML(p.symbol, colorOf(p.id))}
      <span>${esc(p.name)}${p.id === me ? ' (you)' : ''}</span><span class="wins">${p.wins} ${p.wins === 1 ? 'win' : 'wins'}</span></li>`).join('');
    $('#rematchBtn').classList.toggle('hidden', !isHost);
    $('#toLobbyBtn').classList.toggle('hidden', !isHost);
    $('#rematchWait').classList.toggle('hidden', isHost);
  }

  // ---------- top bar ----------
  const muteBtn = $('#muteBtn');
  const syncMute = () => { muteBtn.setAttribute('aria-pressed', String(Sound.muted)); muteBtn.setAttribute('aria-label', Sound.muted ? 'Unmute sound' : 'Mute sound'); };
  muteBtn.addEventListener('click', () => { Sound.setMuted(!Sound.muted); syncMute(); });
  syncMute();
  $('#leaveBtn').addEventListener('click', () => {
    if (S && S.phase === 'playing' && !window.confirm('Leave this game? You’ll be eliminated.')) return;
    socket.emit('leave', {});
    tab.del(SESSION); store.del(LAST); me = null; S = null;
    Sound.stopBubbling();
    history.replaceState(null, '', '/');
    show('home');
  });

  // ---------- dispatcher ----------
  function render() {
    if (!S) return;
    if (S.phase === 'lobby') { show('lobby'); renderLobby(); Sound.stopBubbling(); lastRoundNo = 0; }
    else if (S.phase === 'playing') { show('game'); renderGame(); }
    else { show('results'); renderResults(); Sound.stopBubbling(); lastRoundNo = 0; }
  }
})();

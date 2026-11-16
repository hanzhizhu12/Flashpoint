// Procedural lab sounds with Web Audio: bubbling, pass blip, wrong buzz, fizz-over, win jingle.
(function () {
  const KEY = 'flashpoint.muted';
  let muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (_) { /* storage blocked */ }

  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let bubbleTimer = null;
  let heat = 0; // 0 calm … 1 about to boil
  let bubbling = false;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  // Browsers only allow audio after a gesture.
  const unlock = () => { const c = ensure(); if (c && c.state === 'suspended') c.resume(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));

  function env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function blip(freq, dur, type = 'sine', peak = 0.3, glide = 1.6, when = 0) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * glide, t + dur);
    env(g, t, 0.008, peak, dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function bubble() {
    // a "bloop": short sine with an upward sweep, pitch drifts up with heat
    const base = 220 + Math.random() * 380 + heat * 300;
    blip(base, 0.05 + Math.random() * 0.05, 'sine', 0.08 + heat * 0.12, 1.8 + Math.random());
  }

  function scheduleBubbles() {
    clearTimeout(bubbleTimer);
    if (!bubbling) return;
    if (ctx && !muted) {
      bubble();
      if (heat > 0.6 && Math.random() < heat - 0.4) bubble();
    }
    const gap = 420 - heat * 350; // 420ms calm → 70ms frantic
    bubbleTimer = setTimeout(scheduleBubbles, gap * (0.6 + Math.random() * 0.8));
  }

  function noise(dur, { from = 3000, to = 400, q = 0.8, peak = 0.35, when = 0 } = {}) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    env(g, t, 0.03, peak, dur);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  window.Sound = {
    get muted() { return muted; },
    setMuted(m) {
      muted = !!m;
      try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (_) { /* ignore */ }
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.02);
    },
    setHeat(h) { heat = Math.max(0, Math.min(1, h)); },
    startBubbling() { if (!bubbling) { bubbling = true; scheduleBubbles(); } },
    stopBubbling() { bubbling = false; clearTimeout(bubbleTimer); },
    pass() { blip(660, 0.08, 'triangle', 0.25, 1.0); blip(990, 0.12, 'triangle', 0.25, 1.05, 0.07); },
    wrong() { blip(150, 0.16, 'square', 0.12, 0.8); },
    used() { blip(330, 0.09, 'square', 0.08, 1); blip(330, 0.09, 'square', 0.08, 1, 0.12); },
    fizz() {
      noise(1.6, { from: 5000, to: 300, peak: 0.45 });
      noise(0.9, { from: 900, to: 2500, q: 2, peak: 0.2, when: 0.15 });
      for (let i = 0; i < 18; i++) blip(300 + Math.random() * 900, 0.06, 'sine', 0.12, 2.2, Math.random() * 1.2);
    },
    round() { blip(440, 0.1, 'sine', 0.18, 1.5); },
    win() { [523, 659, 784, 1047].forEach((f, i) => blip(f, 0.22, 'triangle', 0.22, 1.0, i * 0.12)); },
    tick() { blip(1200, 0.03, 'square', 0.04, 1); },
  };
})();

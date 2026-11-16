// Real-browser check: three tabs in one Chrome window play a full game.
// Usage: npm run test:browser   (set CHROME_PATH if Chrome isn't in the default macOS location)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const content = require('../data/categories.json');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 3456;
const URL = `http://localhost:${PORT}`;
const OUT = path.join(__dirname, '..', 'test-artifacts');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
let failures = 0;
const check = (cond, msg) => { console.log(cond ? '  ✔' : '  ✘', msg); if (!cond) failures++; };

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), FLASK_START_MS: '5000', FLASK_STEP_MS: '500', FLASK_MIN_MS: '2500', INTERMISSION_MS: '1500', REJOIN_MS: '8000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('running') && res()));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } }); // one window → tabs share storage
  const errors = [];
  const newTab = async (label, viewport) => {
    const p = await ctx.newPage();
    if (viewport) await p.setViewportSize(viewport);
    p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
    p.label = label;
    return p;
  };

  try {
    // ---------- joining ----------
    log('Joining');
    const A = await newTab('A');
    await A.goto(URL);
    await A.fill('#nameInput', 'Ada');
    await A.fill('#symbolInput', 'Au');
    await A.screenshot({ path: `${OUT}/1-home.png` });
    await A.click('#createBtn');
    await A.waitForSelector('#screen-lobby.active');
    const code = (await A.textContent('#roomCode')).trim();
    check(/^[A-Z]{4}$/.test(code), `room code ${code}`);

    const B = await newTab('B');
    await B.goto(`${URL}/?room=${code}`);
    check((await B.inputValue('#codeInput')) === code, 'invite link pre-fills the code');
    await B.fill('#nameInput', 'Bo');
    await B.fill('#symbolInput', 'ne');
    await B.click('#joinBtn');

    const C = await newTab('C', { width: 390, height: 844 }); // phone-sized tab
    await C.goto(URL);
    await C.fill('#nameInput', 'Cy');
    await C.fill('#codeInput', code.toLowerCase());
    await C.click('#joinBtn');
    await C.waitForSelector('#screen-lobby.active');
    await A.waitForFunction(() => document.querySelectorAll('#lobbyPlayers .player-cell:not(.empty)').length === 3);
    check(true, 'all three tabs in the lobby');
    check(await C.isHidden('#startBtn'), 'non-host sees no start button');
    await A.click('[data-lives="-1"]'); // 3 → 2 lives
    await C.waitForFunction(() => document.querySelector('#guestSettings').textContent.startsWith('2 lives'));
    check(true, 'guests see the host’s settings');
    await A.screenshot({ path: `${OUT}/2-lobby.png` });
    await C.screenshot({ path: `${OUT}/2-lobby-phone.png`, fullPage: true });

    // ---------- turns ----------
    log('Turns');
    await A.click('#startBtn');
    const tabs = [A, B, C];
    await Promise.all(tabs.map((t) => t.waitForSelector('#screen-game.active')));
    check(true, 'game started in all tabs');

    const holder = async () => {
      for (const t of tabs) if (await t.evaluate(() => document.querySelector('#turnText').classList.contains('mine'))) return t;
      return null;
    };
    const answerFor = async (t) => {
      const prompt = (await t.textContent('#promptText')).trim();
      const used = await t.$$eval('#usedList li', (lis) => lis.map((li) => li.childNodes[1].textContent.trim()));
      const cat = content.categories.find((c) => c.prompt === prompt);
      const a = cat.answers.find((x) => !used.includes(x[0])); return a[1] ?? a[0];
    };

    let h = await holder();
    check(!!h, `tab ${h && h.label} holds the flask`);
    await h.fill('#answerInput', 'unobtainium');
    await h.press('#answerInput', 'Enter');
    await A.waitForFunction(() => document.querySelector('#attempt .bad'));
    check(true, 'wrong answer shown struck-through to everyone');
    const ans = await answerFor(h);
    await h.fill('#answerInput', `  ${ans.toUpperCase()} `);
    await h.press('#answerInput', 'Enter');
    await Promise.all(tabs.map((t) => t.waitForFunction(() => document.querySelectorAll('#usedList li').length === 1)));
    check(true, `“${ans}” accepted and shown live in all three tabs`);
    const h2 = await holder();
    check(h2 && h2 !== h, `flask passed from ${h.label} to ${h2 && h2.label}`);
    await A.screenshot({ path: `${OUT}/3-turns.png` });
    await C.screenshot({ path: `${OUT}/3-turns-phone.png` });

    // ---------- overflow ----------
    log('Overflow');
    const loser = h2.label;
    await A.waitForSelector('#flaskWrap.boom', { timeout: 8000 });
    await sleep(500);
    await A.screenshot({ path: `${OUT}/4-boil-over.png` });
    const lostLife = await A.evaluate((name) => {
      const seat = [...document.querySelectorAll('.seat')].find((s) => s.querySelector('.player-name').textContent === name);
      return seat.querySelectorAll('.life.gone').length;
    }, { A: 'Ada', B: 'Bo', C: 'Cy' }[loser]);
    check(lostLife === 1, `${loser} lost a life when the timer ran out`);

    // ---------- rejoining ----------
    log('Rejoining');
    await C.reload();
    await C.waitForSelector('#screen-game.active', { timeout: 5000 });
    const cName = await C.evaluate(() => [...document.querySelectorAll('.seat')].length);
    check(cName === 3, 'reloaded tab C is back in the same game');
    await A.waitForFunction(() => ![...document.querySelectorAll('.seat')].some((s) => s.classList.contains('offline')));
    check(true, 'others see C online again');

    // ---------- winning ----------
    log('Winning (letting fuses burn)');
    await A.waitForSelector('#screen-results.active', { timeout: 60000 });
    const winner = (await A.textContent('#winnerBox .wname')).trim();
    check(/wins!/.test(winner), `results: ${winner}`);
    await A.screenshot({ path: `${OUT}/5-results.png` });
    await C.screenshot({ path: `${OUT}/5-results-phone.png`, fullPage: true });
    check(await B.isHidden('#rematchBtn'), 'only host sees Rematch');
    await A.click('#rematchBtn');
    await Promise.all(tabs.map((t) => t.waitForSelector('#screen-game.active')));
    check(true, 'rematch restarts the game for everyone');

    // mute toggle
    await A.click('#muteBtn');
    check((await A.getAttribute('#muteBtn', 'aria-pressed')) === 'true', 'mute toggle works');
  } finally {
    check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed. Screenshots in test-artifacts/');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

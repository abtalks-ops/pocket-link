// End-to-end test: two separate Chrome profiles pair through the UI (pasting codes instead
// of scanning), chat, send files, and resume an interrupted transfer.
// Usage: NO_HTTPS=1 npm run build && npx vite preview --port 4173 &  then  node e2e/two-peers.mjs
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = process.env.APP_URL ?? 'http://localhost:4173/';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const shots = process.env.SHOTS ?? 'e2e/screenshots';
mkdirSync(shots, { recursive: true });
const tmp = '/tmp/pl-e2e';
mkdirSync(tmp, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const mk = async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e));
  page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
  await page.goto(URL);
  return page;
};
const A = await mk();
const B = await mk();

for (const [p, n] of [[A, 'Alice'], [B, 'Bob']]) {
  await p.fill('#name', n);
  await p.click('text=Get started');
  await p.waitForSelector('text=Pair with a friend');
}
await A.screenshot({ path: `${shots}/1-home-empty.png` });

const codeOf = (p) => p.waitForFunction(() => globalThis.__pocketLink.snapshot().pairing?.localCode || null, null, { timeout: 15000 }).then((h) => h.jsonValue());

async function pair(shotPrefix) {
  await A.goto(URL + '#/pair');
  await B.goto(URL + '#/pair');
  await A.click('text=Start: show my code');
  const offer = await codeOf(A);
  if (shotPrefix) await A.screenshot({ path: `${shots}/${shotPrefix}-a-offer.png` });
  await B.click('text=Join: scan my friend’s code');
  await B.click('text=No camera? Paste the code instead');
  await B.fill('textarea', offer);
  await B.click('text=Use this code');
  await B.waitForSelector('text=Now let your friend scan this reply');
  const answer = await codeOf(B);
  if (shotPrefix) await B.screenshot({ path: `${shots}/${shotPrefix}-b-answer.png` });
  await A.click('text=Next: scan their reply code');
  await A.click('text=No camera? Paste the code instead');
  await A.fill('textarea', answer);
  await A.click('text=Use this code');
  await A.waitForURL(/#\/chat\//, { timeout: 30000 });
  await B.waitForURL(/#\/chat\//, { timeout: 30000 });
  await A.waitForSelector('.sub:text("Connected")');
  await B.waitForSelector('.sub:text("Connected")');
  return { offer, answer };
}

const t0 = Date.now();
const { offer, answer } = await pair('2');
log(`paired in ${Date.now() - t0} ms; offer code ${offer.length} chars, answer code ${answer.length} chars`);
const diag = await A.evaluate(() => Object.values(globalThis.__pocketLink.snapshot().links)[0]?.pair);
log('selected route:', diag);

// Text, receipts, typing
await B.fill('input[aria-label="Message"]', 'typing test');
await A.waitForSelector('.sub:text("typing…")', { timeout: 5000 });
log('typing indicator OK');
await B.fill('input[aria-label="Message"]', '');
await A.fill('input[aria-label="Message"]', 'Hey Bob 👋');
await A.click('button[aria-label="Send"]');
await B.waitForSelector('.bubble.them >> text=Hey Bob 👋');
await A.waitForSelector('.bubble.me .ticks.read', { timeout: 5000 });
log('message delivered and read receipt received');
await B.fill('input[aria-label="Message"]', 'Hi Alice!');
await B.press('input[aria-label="Message"]', 'Enter');
await A.waitForSelector('.bubble.them >> text=Hi Alice!');

// Files: a PNG photo and a 40 MB binary
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const png = await A.screenshot();
writeFileSync(`${tmp}/photo.png`, png);
const big = randomBytes(40 * 1024 * 1024);
writeFileSync(`${tmp}/big.bin`, big);
const receivedHash = (p, name) =>
  p.evaluate(async (name) => {
    const db = globalThis.__pocketLinkDb;
    const f = await db.files.filter((x) => x.name === name).first();
    if (!f || f.state !== 'complete') return null;
    const segs = await db.segments.where('fileId').equals(f.id).sortBy('index');
    const buf = await new Blob(segs.map((s) => s.data)).arrayBuffer();
    const d = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
  }, name);
const waitHash = async (p, name, timeout = 120000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const h = await receivedHash(p, name);
    if (h) return h;
    await p.waitForTimeout(250);
  }
  throw new Error('timeout waiting for ' + name);
};

await A.setInputFiles('input[type=file]', `${tmp}/photo.png`);
assert((await waitHash(B, 'photo.png')) === sha(png), 'photo hash mismatch');
await B.waitForSelector('.bubble.them .file img');
log('photo received intact and shown as image');

let t = Date.now();
await A.setInputFiles('input[type=file]', `${tmp}/big.bin`);
assert((await waitHash(B, 'big.bin')) === sha(big), 'big file hash mismatch');
const secs = (Date.now() - t) / 1000;
log(`40 MB file received intact in ${secs.toFixed(1)} s (${(40 / secs).toFixed(1)} MB/s)`);
await A.waitForSelector('.bubble.me:has(.file-name:text("big.bin")) .ticks.delivered, .bubble.me:has(.file-name:text("big.bin")) .ticks.read');
await A.screenshot({ path: `${shots}/3-chat-a.png` });
await B.screenshot({ path: `${shots}/3-chat-b.png` });

// Resume: cut the link mid-transfer, then pair again
const big2 = randomBytes(80 * 1024 * 1024);
writeFileSync(`${tmp}/resume.bin`, big2);
await A.setInputFiles('input[type=file]', `${tmp}/resume.bin`);
for (let i = 0; ; i++) {
  // waitForFunction does not await async predicates, so poll by hand.
  const done = await B.evaluate(async () => (await globalThis.__pocketLinkDb.files.filter((x) => x.name === 'resume.bin').first())?.doneChunks ?? 0);
  if (done > 200) break;
  assert(i < 600, 'resume.bin never started');
  await B.waitForTimeout(50);
}
await A.evaluate(() => { const m = globalThis.__pocketLink; for (const id of Object.keys(m.snapshot().links)) m.disconnect(id); });
await B.waitForSelector('text=Not connected. Messages you write will be sent when you pair again.');
let paused;
for (let i = 0; i < 100; i++) {
  paused = await B.evaluate(async () => {
    const f = await globalThis.__pocketLinkDb.files.filter((x) => x.name === 'resume.bin').first();
    return { state: f.state, done: f.doneChunks, total: f.totalChunks };
  });
  if (paused.state !== 'transferring') break;
  await B.waitForTimeout(50);
}
log('after disconnect, receiver has', paused);
assert(paused.state === 'paused' && paused.done > 0 && paused.done < paused.total, 'expected a paused partial file');
// Write while offline: should queue and send on reconnect
await A.fill('input[aria-label="Message"]', 'sent while offline');
await A.click('button[aria-label="Send"]');
await A.waitForSelector('.bubble.me .ticks.pending');
await B.screenshot({ path: `${shots}/4-paused-b.png` });
await pair();
assert((await waitHash(B, 'resume.bin')) === sha(big2), 'resumed file hash mismatch');
log('interrupted 80 MB transfer resumed and completed intact');
await B.waitForSelector('.bubble.them >> text=sent while offline');
log('queued offline message delivered after re-pairing');
const friends = await B.evaluate(() => globalThis.__pocketLinkDb.friends.count());
assert(friends === 1, 're-pairing should reuse the same friend, got ' + friends);

// History survives a reload
await B.reload();
await B.waitForSelector('.bubble.them >> text=Hey Bob 👋');
log('history persisted across reload');

await browser.close();
log('ALL E2E CHECKS PASSED');

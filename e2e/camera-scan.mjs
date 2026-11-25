// Checks the real camera path: phone B scans phone A's on-screen QR code through
// getUserMedia + jsQR. Chrome's fake camera plays a video made from a screenshot of A's code.
// Needs ffmpeg. Usage: (preview running on :4173) node e2e/camera-scan.mjs
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const URL = process.env.APP_URL ?? 'http://localhost:4173/';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const tmp = '/tmp/pl-e2e';
mkdirSync(tmp, { recursive: true });
const flags = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

async function phone(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ['camera'] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error(name, 'pageerror', e));
  await p.goto(URL);
  await p.fill('#name', name);
  await p.click('text=Get started');
  await p.goto(URL + '#/pair');
  return p;
}

const ba = await chromium.launch({ executablePath: CHROME, args: flags });
const A = await phone(ba, 'Alice');
await A.click('text=Start: show my code');
await A.waitForSelector('.qr canvas');
await A.locator('.qr canvas').screenshot({ path: `${tmp}/qr.png` });
// Pad the code onto a grey 1280x720 frame, a bit like a phone held up to a camera.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', `${tmp}/qr.png`, '-t', '3', '-r', '15',
  '-vf', 'scale=-1:560,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x808080', '-pix_fmt', 'yuv420p', `${tmp}/qr.y4m`]);

const bb = await chromium.launch({ executablePath: CHROME, args: [...flags, `--use-file-for-fake-video-capture=${tmp}/qr.y4m`] });
const B = await phone(bb, 'Bob');
const t = Date.now();
await B.click('text=Join: scan my friend’s code');
await B.waitForSelector('text=Now let your friend scan this reply', { timeout: 20000 });
console.log(`B decoded A's QR code from the camera in ${Date.now() - t} ms`);

// Finish the pairing by pasting B's reply into A, to prove the scanned offer was usable.
const answer = await B.evaluate(() => globalThis.__pocketLink.snapshot().pairing.localCode);
await A.click('text=Next: scan their reply code');
await A.click('text=No camera? Paste the code instead');
await A.fill('textarea', answer);
await A.click('text=Use this code');
await A.waitForURL(/#\/chat\//, { timeout: 30000 });
await B.waitForURL(/#\/chat\//, { timeout: 30000 });
console.log('CAMERA SCAN CHECK PASSED: pairing completed from a camera-scanned code');
await ba.close();
await bb.close();

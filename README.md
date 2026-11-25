# Pocket Link

Chat and share photos and files with a friend standing next to you. Phone to phone over WebRTC, paired by scanning two QR codes. No accounts, no backend, nothing stored anywhere except the two phones.

This is the MVP: 1:1 chat, QR pairing, text with delivery/read receipts and typing status, photo and file sharing up to 500 MB with resume, and history saved on the device. It installs as a PWA and opens offline.

## How it works

| Part | What it does |
| --- | --- |
| Pairing (`src/lib/peer.ts`, `src/lib/signal.ts`) | Phone A creates a WebRTC offer and waits for ICE gathering to finish. The SDP is trimmed (TCP candidates and optional fields dropped), deflated and base64url-encoded into a QR code of about 480 characters. Phone B scans it and shows its answer as a second QR code. Phone A scans that, and the phones connect directly. There is no signaling server. |
| Identity (`src/lib/identity.ts`) | Each install creates an ECDSA P-256 key pair. The private key is non-extractable and kept in IndexedDB. After the link opens, both sides exchange a `hello` and sign the other side's random nonce, so a friend is recognised by their key when you pair again. The chat menu shows a safety code that matches on both phones. |
| Protocol (`src/lib/protocol.ts`, `src/lib/manager.ts`) | Two data channels. `ctrl` carries small JSON packets (messages, receipts, typing, file control). `file` carries binary chunks so a big transfer never delays a text message. |
| Files | 64 KB chunks (16 KB if the link's max message size is smaller). The sender pauses when `bufferedAmount` passes 4 MB and continues at 1 MB. The receiver writes ~1 MB segments to IndexedDB as they arrive, so large files are not held in memory. If the link drops, both sides mark the file paused. After you pair again, the receiver asks for the first chunk it does not have and the transfer continues from there. Messages written while offline are queued and sent on the next pairing. |
| Storage (`src/lib/db.ts`) | Dexie over IndexedDB: identity, friends, messages, file records, file segments. |
| PWA | `vite-plugin-pwa` (Workbox) precaches the app so it opens offline and can be installed to the home screen. |

## Run it locally

Requires Node 20 or newer.

```bash
npm install
npm run dev          # https://<your-computer-ip>:5173 on your Wi-Fi
```

The dev server uses a self-signed HTTPS certificate because phones only allow the camera on HTTPS pages. Your browser will warn about the certificate the first time; accept it to continue. Use `NO_HTTPS=1 npm run dev` for plain http on `localhost`.

On a laptop you can try it with two browser profiles (or one normal and one private window) and the "No camera? Paste the code instead" link on the scan screen.

## Deploy

It is a static site: `npm run build` writes everything to `dist/`.

**GitHub Pages (set up in this repo):** in the repository go to Settings → Pages and set Source to "GitHub Actions". Every push to `main` then runs `.github/workflows/deploy.yml`, which tests, builds with the right sub-path and publishes to `https://<user>.github.io/pocket-link/`.

**Cloudflare Pages:** create a Pages project from this repo with build command `npm run build`, output directory `dist`, and the environment variable `NO_HTTPS=1`. Leave `BASE_PATH` unset (the site is served from the root).

If you host under any other sub-path, build with `BASE_PATH=/your-path/`.

## Test on two real phones

1. Deploy (above), or run `npm run dev` and open the `https://<ip>:5173` address it prints on both phones. Both phones must be able to reach that address.
2. Put both phones on the same Wi-Fi, or turn on a hotspot on phone A and connect phone B to it.
3. On each phone, open the site, enter a name, and optionally "Add to Home Screen".
4. Phone A: **Pair with a friend → Start: show my code**. Allow the camera when asked.
5. Phone B: **Pair with a friend → Join: scan my friend's code**, and scan A's screen. B now shows a reply code.
6. Phone A: tap **Next: scan their reply code** and scan B's screen. Both phones open the chat within a few seconds.
7. Things worth checking: messages both ways, ✓ / ✓✓ / blue ✓✓ (sent / delivered / read), the typing dots, a photo from the gallery, a large video (100 MB+), then turn Wi-Fi off on one phone mid-transfer, turn it back on, pair again, and watch the transfer continue from where it stopped. Messages written while disconnected are sent after the new pairing.
8. If pairing fails, open **Connection details** on the pairing screen. It shows how many local IP addresses and hidden (mDNS) addresses each phone offered and which route was used. Please note the two phone models, browsers and network type for each result.

## Known limits and risks

- **Hidden local addresses (mDNS).** Chrome, Edge and Safari can replace a phone's local IP with a random `*.local` name for privacy. The other phone then has to resolve that name over multicast, which some routers and many hotspots do not pass. Chromium browsers reveal real local IPs while the page has camera access, so the app opens the camera at the start of pairing (before the offer or answer is created) and keeps it open until pairing ends. If a phone denies the camera, the paste fallback still works but it may hit this problem.
- **Client isolation.** Guest, café, campus and office Wi-Fi often block devices from reaching each other. A personal hotspot is the most reliable setup.
- **Public STUN (optional).** Settings has a "Use public STUN server" switch, off by default so pairing never touches the internet. Turning it on (on both phones) adds a public address candidate that helps on some networks. Messages still go phone to phone. There is no TURN relay, so networks that block direct links entirely will not work.
- **No automatic reconnect.** If the screen locks, the app is backgrounded for long, or someone walks out of range, the link drops and you pair again with two scans. History, the friend and paused transfers are kept. Groups and auto-reconnect are planned for later.
- **Storage.** Everything lives in the browser's storage on each phone. The app asks for persistent storage, but clearing site data or uninstalling deletes chats. iOS Safari may evict data for sites not added to the Home Screen after weeks without use.
- **Large files on iPhone.** Safari's storage quota is smaller than Chrome's; a 500 MB file may hit it on a nearly full phone.

## Testing

```bash
npm test             # unit tests: pairing code encoding, chunk framing, identity proofs
npm run typecheck

# End-to-end, needs Chrome (set CHROME=/path/to/chrome if not /usr/bin/google-chrome) and ffmpeg:
NO_HTTPS=1 npm run build
NO_HTTPS=1 npx vite preview --port 4173 &
npm run e2e
```

`e2e/two-peers.mjs` drives two separate browser profiles through the real UI: onboarding, both pairing steps, text both ways, typing indicator, read receipts, a photo and a 40 MB file (checked by SHA-256), then an 80 MB file cut off at about half, a message written while offline, re-pairing, the transfer resuming from the paused chunk and finishing intact, and history surviving a reload.

`e2e/camera-scan.mjs` feeds a screenshot of phone A's QR code into Chrome's fake camera, so phone B decodes it through `getUserMedia` and jsQR exactly as a phone would.

### What has been verified so far

- Unit tests and type check pass.
- Both end-to-end scripts pass in headless Chrome on Linux (two separate browser processes on one machine): pairing in about 1.5 s, 486-character pairing codes, around 10 MB/s file transfer, resume after interruption with an exact hash match.

### Not verified yet

- Real phones, real cameras, and real Wi-Fi or hotspot networks. On one machine the link always runs over loopback, so the mDNS and client-isolation problems above cannot show up there, and headless Chrome did not hide local IPs even without the camera, so the camera workaround is not proven yet.
- Safari / iOS and Firefox. The code avoids Chrome-only APIs, but it has only run in Chrome.
- 500 MB transfers on a phone, and behaviour when the phone locks mid-transfer.

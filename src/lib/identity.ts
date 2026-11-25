import { db, type Identity } from './db';

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
export function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Stable short id for a public key: first 16 bytes of SHA-256 over the JWK's x/y coordinates. */
export async function fingerprint(jwk: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${jwk.crv}:${jwk.x}:${jwk.y}`));
  return toHex(new Uint8Array(digest).slice(0, 16));
}

/** Human-friendly safety code (e.g. "4821 0937") to compare in person if wanted. */
export function safetyCode(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  let h = 0;
  for (const ch of x + y) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = String(h % 100000000).padStart(8, '0');
  return `${n.slice(0, 4)} ${n.slice(4)}`;
}

export async function loadIdentity(): Promise<Identity | undefined> {
  return db.identity.get('me');
}

export async function createIdentity(name: string): Promise<Identity> {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // Re-import the private key as non-extractable before storing it.
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, ALG, false, ['sign']);
  const id = await fingerprint(publicJwk);
  const me: Identity = { key: 'me', id, name, publicJwk, privateKey, createdAt: Date.now() };
  await db.identity.put(me);
  return me;
}

export async function renameIdentity(name: string) {
  await db.identity.update('me', { name });
}

function proofText(nonce: string, signerId: string, verifierId: string) {
  return enc.encode(`pocket-link/v1|${nonce}|${signerId}|${verifierId}`);
}

export async function signProof(me: Identity, peerNonce: string, peerId: string): Promise<string> {
  const sig = await crypto.subtle.sign(SIG, me.privateKey, proofText(peerNonce, me.id, peerId));
  return b64(sig);
}

export async function verifyProof(
  peerJwk: JsonWebKey,
  myNonce: string,
  peerId: string,
  myId: string,
  sigB64: string,
): Promise<boolean> {
  if ((await fingerprint(peerJwk)) !== peerId) return false;
  const key = await crypto.subtle.importKey('jwk', peerJwk, ALG, false, ['verify']);
  return crypto.subtle.verify(SIG, key, unb64(sigB64), proofText(myNonce, peerId, myId));
}

export function randomNonce(): string {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}

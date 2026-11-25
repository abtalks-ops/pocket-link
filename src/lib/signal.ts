import { deflateRaw, inflateRaw } from 'pako';

/**
 * Pairing codes carry a full SDP description (offer or answer) through a QR code.
 * SDP is ~1-2 KB of very repetitive text, so we trim lines that do not matter for
 * a data-channel-only link and deflate the rest. Typical result: 350-700 characters.
 */
export interface PairingPayload {
  type: 'offer' | 'answer';
  /** Random id so an answer can be matched to the offer it replies to. */
  session: string;
  sdp: string;
}

const PREFIX = 'PL1';

/** Remove SDP lines that are safe to drop for a data-channel-only session. */
export function trimSdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  const kept = lines.filter((l) => {
    if (l.startsWith('a=candidate:')) {
      // TCP candidates almost never help between two phones on one Wi-Fi.
      if (/ tcp /i.test(l)) return false;
    }
    if (l.startsWith('a=extmap-allow-mixed')) return false;
    if (l.startsWith('a=msid-semantic')) return false;
    return true;
  });
  // Drop the optional generation/network-id/network-cost suffixes from candidates.
  return (
    kept
      .map((l) =>
        l.startsWith('a=candidate:')
          ? l.replace(/ generation \d+/, '').replace(/ network-id \d+/, '').replace(/ network-cost \d+/, '')
          : l,
      )
      .join('\r\n') + '\r\n'
  );
}

function toB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodePairing(p: PairingPayload): string {
  const body = `${p.session}\n${trimSdp(p.sdp)}`;
  const packed = deflateRaw(new TextEncoder().encode(body), { level: 9 });
  return `${PREFIX}${p.type === 'offer' ? 'O' : 'A'}${toB64Url(packed)}`;
}

export class PairingCodeError extends Error {}

export function decodePairing(code: string): PairingPayload {
  const c = code.trim();
  if (!c.startsWith(PREFIX)) throw new PairingCodeError('This is not a Pocket Link code.');
  const t = c[PREFIX.length];
  if (t !== 'O' && t !== 'A') throw new PairingCodeError('Unknown Pocket Link code type.');
  let text: string;
  try {
    text = new TextDecoder().decode(inflateRaw(fromB64Url(c.slice(PREFIX.length + 1))));
  } catch {
    throw new PairingCodeError('The code is damaged or incomplete. Try scanning again.');
  }
  const nl = text.indexOf('\n');
  if (nl < 0 || !text.includes('v=0')) throw new PairingCodeError('The code is damaged.');
  return { type: t === 'O' ? 'offer' : 'answer', session: text.slice(0, nl), sdp: text.slice(nl + 1) };
}

/** Summarise the ICE candidates in an SDP, used for connection diagnostics. */
export function describeCandidates(sdp: string) {
  const c = sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:'));
  const host = c.filter((l) => / typ host/.test(l));
  return {
    total: c.length,
    host: host.length,
    mdns: host.filter((l) => /\.local /.test(l)).length,
    ip: host.filter((l) => !/\.local /.test(l)).length,
    srflx: c.filter((l) => / typ srflx/.test(l)).length,
    relay: c.filter((l) => / typ relay/.test(l)).length,
  };
}

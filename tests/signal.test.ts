import { describe, expect, it } from 'vitest';
import { decodePairing, describeCandidates, encodePairing, PairingCodeError, trimSdp } from '../src/lib/signal';
import { decodeChunk, encodeChunk } from '../src/lib/protocol';
import { fingerprint, safetyCode } from '../src/lib/identity';

// A real Chrome data-channel offer (addresses changed).
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1467250027 1 udp 2122260223 192.168.1.23 54321 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:2850319821 1 udp 2122260223 4f2c6a1e-1e5d-4f3a-9d44-0f7e0f8b2b7c.local 54322 typ host generation 0 network-id 2',
  'a=candidate:1467250027 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-id 1',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:aaaaaaaaaaaaaaaaaaaaaaaa',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 8C:71:B9:30:27:2E:92:13:6A:49:E7:2A:1E:EE:53:36:9C:01:AB:6D:41:3B:72:BC:8A:5D:7C:8F:1F:8A:2E:AF',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

describe('pairing codes', () => {
  it('round-trips an offer and keeps what WebRTC needs', () => {
    const code = encodePairing({ type: 'offer', session: 'abc123', sdp: SDP });
    expect(code.startsWith('PL1O')).toBe(true);
    const back = decodePairing(code);
    expect(back.type).toBe('offer');
    expect(back.session).toBe('abc123');
    for (const keep of ['a=ice-ufrag:abcd', 'a=fingerprint:sha-256 8C:71', 'a=sctp-port:5000', 'typ host', 'a=setup:actpass'])
      expect(back.sdp).toContain(keep);
    expect(back.sdp).not.toContain(' tcp ');
    expect(back.sdp).not.toContain('generation');
  });

  it('is much smaller than the raw SDP', () => {
    const code = encodePairing({ type: 'answer', session: 'x', sdp: SDP });
    expect(code.length).toBeLessThan(SDP.length * 0.75);
  });

  it('rejects junk with a readable error', () => {
    expect(() => decodePairing('hello')).toThrow(PairingCodeError);
    expect(() => decodePairing('PL1Oxxxx')).toThrow(PairingCodeError);
  });

  it('counts candidate kinds for diagnostics', () => {
    const d = describeCandidates(trimSdp(SDP));
    expect(d).toMatchObject({ total: 2, host: 2, mdns: 1, ip: 1, srflx: 0 });
  });
});

describe('binary chunk frames', () => {
  it('round-trips id, index and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const f = decodeChunk(encodeChunk('a1b2c3d4e5f6a1b2c3d4e5f6', 70000, payload));
    expect(f.fileId).toBe('a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(f.index).toBe(70000);
    expect(Array.from(f.payload)).toEqual([1, 2, 3, 250]);
  });
  it('handles empty payloads', () => {
    expect(decodeChunk(encodeChunk('id', 0, new Uint8Array())).payload.length).toBe(0);
  });
});

describe('identity helpers', () => {
  it('fingerprints are stable and safety codes are symmetric', async () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
    expect(await fingerprint(jwk)).toBe(await fingerprint({ ...jwk }));
    expect(safetyCode('aaa', 'bbb')).toBe(safetyCode('bbb', 'aaa'));
    expect(safetyCode('aaa', 'bbb')).toMatch(/^\d{4} \d{4}$/);
  });
});

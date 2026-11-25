/** JSON packets sent on the "ctrl" data channel. Kept small on purpose. */
export type Packet =
  | { t: 'hello'; v: 1; id: string; name: string; jwk: JsonWebKey; nonce: string }
  | { t: 'proof'; sig: string }
  | { t: 'msg'; id: string; text: string; ts: number }
  | { t: 'ack'; id: string; s: 'delivered' | 'read' }
  | { t: 'typing'; on: boolean }
  | { t: 'name'; name: string }
  // File transfer
  | { t: 'f-offer'; id: string; msgId: string; name: string; size: number; mime: string; chunkSize: number; ts: number }
  | { t: 'f-resume'; id: string; from: number } // receiver: "send from chunk N"
  | { t: 'f-progress'; id: string; done: number } // receiver: chunks safely stored
  | { t: 'f-done'; id: string } // receiver: file complete and stored
  | { t: 'f-cancel'; id: string };

/**
 * Binary frames on the "file" channel:
 *   [u8 idLength][id bytes (ascii)][u32 chunkIndex big-endian][payload]
 */
export function encodeChunk(fileId: string, index: number, payload: Uint8Array): ArrayBuffer {
  const idBytes = new TextEncoder().encode(fileId);
  const buf = new Uint8Array(1 + idBytes.length + 4 + payload.length);
  buf[0] = idBytes.length;
  buf.set(idBytes, 1);
  new DataView(buf.buffer).setUint32(1 + idBytes.length, index);
  buf.set(payload, 5 + idBytes.length);
  return buf.buffer;
}

export function decodeChunk(data: ArrayBuffer): { fileId: string; index: number; payload: Uint8Array } {
  const u8 = new Uint8Array(data);
  const len = u8[0];
  const fileId = new TextDecoder().decode(u8.subarray(1, 1 + len));
  const index = new DataView(data).getUint32(1 + len);
  return { fileId, index, payload: u8.subarray(5 + len) };
}

export const MAX_FILE_BYTES = 500 * 1024 * 1024;

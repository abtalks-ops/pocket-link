import Dexie, { type EntityTable } from 'dexie';

export interface Identity {
  key: 'me';
  id: string; // fingerprint of our public key
  name: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey; // non-extractable, stored via structured clone
  createdAt: number;
}

export interface Friend {
  id: string; // fingerprint of their public key
  name: string;
  publicJwk: JsonWebKey;
  addedAt: number;
  lastSeen: number;
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  friendId: string;
  from: 'me' | 'them';
  kind: 'text' | 'file';
  text?: string;
  fileId?: string;
  ts: number;
  status: MessageStatus;
}

export type FileState = 'pending' | 'transferring' | 'paused' | 'complete' | 'failed' | 'cancelled';

export interface FileRecord {
  id: string;
  friendId: string;
  direction: 'out' | 'in';
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  totalChunks: number;
  /** Number of chunks safely written (in) or acknowledged by the receiver (out). */
  doneChunks: number;
  state: FileState;
  /** Outgoing files keep the original Blob so transfers can resume after a restart. */
  blob?: Blob;
  ts: number;
}

/** Incoming files are written to disk as ~1 MB segments instead of being held in memory. */
export interface Segment {
  fileId: string;
  index: number; // segment number
  firstChunk: number;
  chunkCount: number;
  data: Blob;
}

class PocketDB extends Dexie {
  identity!: EntityTable<Identity, 'key'>;
  friends!: EntityTable<Friend, 'id'>;
  messages!: EntityTable<Message, 'id'>;
  files!: EntityTable<FileRecord, 'id'>;
  segments!: Dexie.Table<Segment, [string, number]>;

  constructor() {
    super('pocket-link');
    this.version(1).stores({
      identity: 'key',
      friends: 'id, lastSeen',
      messages: 'id, friendId, [friendId+ts], status',
      files: 'id, friendId, state',
      segments: '[fileId+index], fileId',
    });
  }
}

export const db = new PocketDB();

export async function assembleFile(fileId: string): Promise<Blob | undefined> {
  const rec = await db.files.get(fileId);
  if (!rec) return undefined;
  if (rec.direction === 'out') return rec.blob;
  if (rec.state !== 'complete') return undefined;
  const segs = await db.segments.where('fileId').equals(fileId).sortBy('index');
  return new Blob(segs.map((s) => s.data), { type: rec.mime || 'application/octet-stream' });
}

export async function deleteFriend(friendId: string) {
  await db.transaction('rw', [db.friends, db.messages, db.files, db.segments], async () => {
    const files = await db.files.where('friendId').equals(friendId).primaryKeys();
    for (const f of files) await db.segments.where('fileId').equals(f).delete();
    await db.files.where('friendId').equals(friendId).delete();
    await db.messages.where('friendId').equals(friendId).delete();
    await db.friends.delete(friendId);
  });
}

export function uid(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

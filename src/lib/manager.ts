import { db, uid, type FileRecord, type Identity, type Message } from './db';
import { PeerSession } from './peer';
import { decodeChunk, encodeChunk, MAX_FILE_BYTES, type Packet } from './protocol';
import { fingerprint, randomNonce, signProof, verifyProof } from './identity';

/**
 * Owns every live link and speaks the Pocket Link protocol on top of it:
 * handshake (identity proof), text messages, receipts, typing and file transfer.
 * React reads it through `subscribe` / `snapshot`.
 */

const SEGMENT_BYTES = 1024 * 1024; // incoming data is flushed to IndexedDB in ~1 MB pieces
const READ_BYTES = 1024 * 1024; // outgoing data is read from the Blob in ~1 MB pieces
const HIGH_WATER = 4 * 1024 * 1024; // pause sending above this bufferedAmount
const LOW_WATER = 1024 * 1024;

export type LinkState = 'handshake' | 'online' | 'unstable' | 'offline';

interface Link {
  peer: PeerSession;
  state: LinkState;
  friendId?: string;
  myNonce: string;
  peerHello?: Extract<Packet, { t: 'hello' }>;
  helloSent: boolean;
  /** Control packets are handled one at a time, in arrival order. */
  ctrlQueue: Promise<void>;
  typing: boolean;
  typingTimer?: ReturnType<typeof setTimeout>;
  sendQueue: Promise<void>;
  activeSends: Set<string>;
}

interface Incoming {
  rec: FileRecord;
  next: number; // next expected chunk index
  buf: Uint8Array[];
  bufBytes: number;
  bufFirst: number;
  writing: Promise<void>;
}

export interface Snapshot {
  version: number;
  pairing?: PeerSession;
  links: Record<string, { state: LinkState; typing: boolean; pair?: string }>;
  /** Live byte progress for files currently moving (fileId → bytes). */
  progress: Record<string, number>;
}

class Manager {
  me?: Identity;
  private links = new Map<string, Link>(); // friendId → link
  private pairingLink?: Link;
  private incoming = new Map<string, Incoming>();
  private listeners = new Set<() => void>();
  private snap: Snapshot = { version: 0, links: {}, progress: {} };
  private progress: Record<string, number> = {};
  private emitQueued = false;
  /** friendId of the chat currently on screen (for read receipts). */
  viewing?: string;
  onPaired?: (friendId: string) => void;

  // ---------- React store ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.snap;
  private emit() {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      const links: Snapshot['links'] = {};
      for (const [id, l] of this.links) links[id] = { state: l.state, typing: l.typing, pair: l.peer.diag.pair };
      this.snap = {
        version: this.snap.version + 1,
        pairing: this.pairingLink?.peer,
        links,
        progress: { ...this.progress },
      };
      this.listeners.forEach((f) => f());
    });
  }

  // ---------- Pairing ----------
  async startPairing(): Promise<PeerSession> {
    this.cancelPairing();
    const peer = await PeerSession.startOffer();
    this.adopt(peer);
    return peer;
  }

  async joinPairing(code: string): Promise<PeerSession> {
    this.cancelPairing();
    const peer = await PeerSession.acceptOffer(code);
    this.adopt(peer);
    return peer;
  }

  async completePairing(code: string) {
    const link = this.pairingLink;
    if (!link) throw new Error('No pairing in progress.');
    await link.peer.acceptAnswer(code);
  }

  cancelPairing() {
    const l = this.pairingLink;
    if (l && !l.friendId) l.peer.close();
    this.pairingLink = undefined;
    this.emit();
  }

  disconnect(friendId: string) {
    this.links.get(friendId)?.peer.close();
  }

  private adopt(peer: PeerSession) {
    const link: Link = {
      peer,
      state: 'handshake',
      myNonce: randomNonce(),
      typing: false,
      helloSent: false,
      ctrlQueue: Promise.resolve(),
      sendQueue: Promise.resolve(),
      activeSends: new Set(),
    };
    this.pairingLink = link;
    peer.addEventListener('change', () => this.onPeerChange(link));
    this.emit();
  }

  private onPeerChange(link: Link) {
    const { peer } = link;
    if (peer.phase === 'open' && link.state === 'handshake' && !link.helloSent && peer.ctrl) {
      link.helloSent = true;
      peer.ctrl.onmessage = (e) => {
        link.ctrlQueue = link.ctrlQueue.then(() => this.onCtrl(link, e.data)).catch((err) => console.warn('packet failed', err));
      };
      peer.file!.onmessage = (e) => this.onFileData(link, e.data);
      peer.file!.bufferedAmountLowThreshold = LOW_WATER;
      this.send(link, { t: 'hello', v: 1, id: this.me!.id, name: this.me!.name, jwk: this.me!.publicJwk, nonce: link.myNonce });
    }
    if (peer.phase === 'unstable' && link.state === 'online') link.state = 'unstable';
    if (peer.phase === 'open' && link.state === 'unstable') link.state = 'online';
    if (peer.phase === 'closed' || peer.phase === 'failed') void this.onLinkDown(link);
    this.emit();
  }

  private async onLinkDown(link: Link) {
    if (link.state === 'offline') return;
    link.state = 'offline';
    link.typing = false;
    const fid = link.friendId;
    if (fid && this.links.get(fid) === link) {
      this.links.delete(fid);
      await db.friends.update(fid, { lastSeen: Date.now() });
      // Anything mid-flight is paused; it resumes after the next pairing.
      const moving = await db.files.where('friendId').equals(fid).filter((f) => f.state === 'transferring').toArray();
      for (const f of moving) {
        await this.flushIncoming(f.id);
        await db.files.where('id').equals(f.id).filter((x) => x.state === 'transferring').modify({ state: 'paused' });
        this.incoming.delete(f.id);
        delete this.progress[f.id];
      }
    }
    this.emit();
  }

  // ---------- Packets ----------
  private send(link: Link, p: Packet): boolean {
    const ch = link.peer.ctrl;
    if (!ch || ch.readyState !== 'open') return false;
    ch.send(JSON.stringify(p));
    return true;
  }

  private async onCtrl(link: Link, raw: unknown) {
    let p: Packet;
    try {
      p = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (link.state === 'handshake') return this.onHandshake(link, p);
    const fid = link.friendId!;
    switch (p.t) {
      case 'msg': {
        if (typeof p.text !== 'string' || p.text.length > 20000) return;
        const exists = await db.messages.get(p.id);
        if (!exists)
          await db.messages.add({ id: p.id, friendId: fid, from: 'them', kind: 'text', text: p.text, ts: p.ts, status: 'delivered' });
        this.send(link, { t: 'ack', id: p.id, s: 'delivered' });
        link.typing = false;
        if (this.viewing === fid) void this.markRead(fid);
        break;
      }
      case 'ack': {
        const m = await db.messages.get(p.id);
        if (m && m.from === 'me' && m.friendId === fid && rank(p.s) > rank(m.status)) await db.messages.update(p.id, { status: p.s });
        break;
      }
      case 'typing':
        link.typing = !!p.on;
        clearTimeout(link.typingTimer);
        if (p.on) link.typingTimer = setTimeout(() => ((link.typing = false), this.emit()), 6000);
        break;
      case 'name':
        if (typeof p.name === 'string') await db.friends.update(fid, { name: p.name.slice(0, 40) });
        break;
      case 'f-offer':
        await this.onFileOffer(link, p);
        break;
      case 'f-resume':
        this.startSending(link, p.id, p.from);
        break;
      case 'f-progress': {
        const f = await db.files.get(p.id);
        if (f && f.direction === 'out' && p.done > f.doneChunks) await db.files.update(p.id, { doneChunks: p.done });
        break;
      }
      case 'f-done': {
        const f = await db.files.get(p.id);
        if (f && f.direction === 'out') {
          await db.files.update(p.id, { state: 'complete', doneChunks: f.totalChunks });
          const m = await db.messages.where('friendId').equals(fid).filter((x) => x.fileId === p.id).first();
          if (m && rank('delivered') > rank(m.status)) await db.messages.update(m.id, { status: 'delivered' });
        }
        delete this.progress[p.id];
        break;
      }
      case 'f-cancel': {
        link.activeSends.delete(p.id);
        const f = await db.files.get(p.id);
        if (f && f.state !== 'complete') await db.files.update(p.id, { state: 'cancelled' });
        this.incoming.delete(p.id);
        delete this.progress[p.id];
        break;
      }
    }
    this.emit();
  }

  private async onHandshake(link: Link, p: Packet) {
    if (p.t === 'hello') {
      if (link.peerHello) return;
      if (p.v !== 1 || !p.jwk || !p.id || (await fingerprint(p.jwk)) !== p.id) return link.peer.close();
      if (p.id === this.me!.id) return link.peer.close();
      link.peerHello = p;
      this.send(link, { t: 'proof', sig: await signProof(this.me!, p.nonce, p.id) });
    } else if (p.t === 'proof' && link.peerHello && !link.friendId) {
      const h = link.peerHello;
      const ok = await verifyProof(h.jwk, link.myNonce, h.id, this.me!.id, p.sig);
      if (!ok) return link.peer.close();
      const existing = await db.friends.get(h.id);
      const now = Date.now();
      if (existing) await db.friends.update(h.id, { name: h.name.slice(0, 40), lastSeen: now });
      else await db.friends.add({ id: h.id, name: h.name.slice(0, 40), publicJwk: h.jwk, addedAt: now, lastSeen: now });
      // One live link per friend: a fresh pairing replaces an old one.
      const old = this.links.get(h.id);
      if (old && old !== link) {
        old.state = 'offline';
        old.peer.close();
      }
      link.friendId = h.id;
      link.state = 'online';
      this.links.set(h.id, link);
      if (this.pairingLink === link) this.pairingLink = undefined;
      this.emit();
      this.onPaired?.(h.id);
      await this.flushPending(link);
    }
  }

  /** After (re)connecting: send queued messages and re-offer unfinished files. */
  private async flushPending(link: Link) {
    const fid = link.friendId!;
    const pending = await db.messages.where('friendId').equals(fid).filter((m) => m.from === 'me' && m.status === 'pending').sortBy('ts');
    for (const m of pending) {
      if (m.kind === 'text' && this.send(link, { t: 'msg', id: m.id, text: m.text!, ts: m.ts })) await db.messages.update(m.id, { status: 'sent' });
    }
    const files = await db.files
      .where('friendId')
      .equals(fid)
      .filter((f) => f.direction === 'out' && ['pending', 'paused', 'transferring'].includes(f.state))
      .toArray();
    for (const f of files) await this.offerFile(link, f);
    if (this.viewing === fid) await this.markRead(fid);
  }

  // ---------- Public chat API ----------
  async sendText(friendId: string, text: string) {
    const m: Message = { id: uid(), friendId, from: 'me', kind: 'text', text, ts: Date.now(), status: 'pending' };
    await db.messages.add(m);
    const link = this.online(friendId);
    if (link && this.send(link, { t: 'msg', id: m.id, text, ts: m.ts })) await db.messages.update(m.id, { status: 'sent' });
    if (link) this.send(link, { t: 'typing', on: false });
  }

  setTyping(friendId: string, on: boolean) {
    const link = this.online(friendId);
    if (link) this.send(link, { t: 'typing', on });
  }

  async markRead(friendId: string) {
    const link = this.online(friendId);
    if (!link) return;
    const unread = await db.messages.where('friendId').equals(friendId).filter((m) => m.from === 'them' && m.status !== 'read').toArray();
    for (const m of unread) {
      if (this.send(link, { t: 'ack', id: m.id, s: 'read' })) await db.messages.update(m.id, { status: 'read' });
    }
  }

  broadcastName(name: string) {
    for (const l of this.links.values()) if (l.state !== 'handshake') this.send(l, { t: 'name', name });
  }

  async sendFile(friendId: string, file: File) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`Files up to ${MAX_FILE_BYTES / 1024 / 1024} MB can be sent.`);
    const id = uid();
    const rec: FileRecord = {
      id,
      friendId,
      direction: 'out',
      name: file.name || 'file',
      size: file.size,
      mime: file.type,
      chunkSize: 0, // chosen when the transfer starts, from the link's max message size
      totalChunks: 0,
      doneChunks: 0,
      state: 'pending',
      blob: file,
      ts: Date.now(),
    };
    await db.files.add(rec);
    await db.messages.add({ id: uid(), friendId, from: 'me', kind: 'file', fileId: id, ts: rec.ts, status: 'pending' });
    const link = this.online(friendId);
    if (link) await this.offerFile(link, rec);
  }

  async cancelFile(fileId: string) {
    const f = await db.files.get(fileId);
    if (!f || f.state === 'complete') return;
    await db.files.update(fileId, { state: 'cancelled' });
    const link = this.online(f.friendId);
    if (link) {
      link.activeSends.delete(fileId);
      this.send(link, { t: 'f-cancel', id: fileId });
    }
    this.incoming.delete(fileId);
    delete this.progress[fileId];
    this.emit();
  }

  private online(friendId: string): Link | undefined {
    const l = this.links.get(friendId);
    return l && (l.state === 'online' || l.state === 'unstable') ? l : undefined;
  }

  // ---------- File transfer: sender ----------
  private async offerFile(link: Link, f: FileRecord) {
    if (!f.chunkSize) {
      const max = link.peer.pc.sctp?.maxMessageSize ?? 65536;
      const chunkSize = max >= 64 * 1024 + 64 ? 64 * 1024 : 16 * 1024;
      f.chunkSize = chunkSize;
      f.totalChunks = Math.max(1, Math.ceil(f.size / chunkSize));
      await db.files.update(f.id, { chunkSize, totalChunks: f.totalChunks });
    }
    const msg = await db.messages.where('friendId').equals(f.friendId).filter((m) => m.fileId === f.id).first();
    if (msg && msg.status === 'pending') await db.messages.update(msg.id, { status: 'sent' });
    this.send(link, { t: 'f-offer', id: f.id, msgId: msg?.id ?? f.id, name: f.name, size: f.size, mime: f.mime, chunkSize: f.chunkSize, ts: f.ts });
  }

  private startSending(link: Link, fileId: string, from: number) {
    if (link.activeSends.has(fileId)) return;
    link.activeSends.add(fileId);
    // Files go one after another so a big video does not starve a photo sent later... in order.
    link.sendQueue = link.sendQueue.then(() => this.pump(link, fileId, from)).catch((e) => console.warn('send failed', e));
  }

  private async pump(link: Link, fileId: string, from: number) {
    const f = await db.files.get(fileId);
    const ch = link.peer.file;
    if (!f || !f.blob || !ch || f.state === 'cancelled' || f.state === 'complete') return void link.activeSends.delete(fileId);
    await db.files.update(fileId, { state: 'transferring' });
    this.emit();
    const wake = await requestWakeLock();
    try {
      let index = Math.max(0, from);
      while (index < f.totalChunks) {
        if (!link.activeSends.has(fileId) || ch.readyState !== 'open') return;
        const start = index * f.chunkSize;
        const piece = new Uint8Array(await f.blob.slice(start, Math.min(f.size, start + READ_BYTES)).arrayBuffer());
        // An empty file is still sent as one empty chunk so the receiver can finish it.
        for (let off = 0; index < f.totalChunks && (off === 0 || off < piece.length); off += f.chunkSize) {
          if (ch.bufferedAmount > HIGH_WATER) await waitForLow(ch);
          if (!link.activeSends.has(fileId) || ch.readyState !== 'open') return;
          ch.send(encodeChunk(fileId, index, piece.subarray(off, off + f.chunkSize)));
          index++;
          this.progress[fileId] = Math.min(f.size, index * f.chunkSize);
          this.emit();
        }
      }
    } finally {
      link.activeSends.delete(fileId);
      wake?.release().catch(() => {});
    }
  }

  // ---------- File transfer: receiver ----------
  private async onFileOffer(link: Link, p: Extract<Packet, { t: 'f-offer' }>) {
    const fid = link.friendId!;
    let rec = await db.files.get(p.id);
    if (rec && rec.friendId !== fid) return;
    if (!rec) {
      if (p.size > MAX_FILE_BYTES || p.size < 0 || !(p.chunkSize > 0) || p.chunkSize > 256 * 1024) {
        return void this.send(link, { t: 'f-cancel', id: p.id });
      }
      rec = {
        id: p.id,
        friendId: fid,
        direction: 'in',
        name: String(p.name).slice(0, 200),
        size: p.size,
        mime: String(p.mime || ''),
        chunkSize: p.chunkSize,
        totalChunks: Math.max(1, Math.ceil(p.size / p.chunkSize)),
        doneChunks: 0,
        state: 'pending',
        ts: p.ts,
      };
      await db.files.add(rec);
      if (!(await db.messages.get(p.msgId)))
        await db.messages.add({ id: p.msgId, friendId: fid, from: 'them', kind: 'file', fileId: p.id, ts: p.ts, status: 'delivered' });
      if (this.viewing === fid) void this.markRead(fid);
    }
    if (rec.state === 'complete') return void this.send(link, { t: 'f-done', id: p.id });
    if (rec.state === 'cancelled') return void this.send(link, { t: 'f-cancel', id: p.id });
    await db.files.update(p.id, { state: 'transferring' });
    rec.state = 'transferring';
    this.incoming.set(p.id, { rec, next: rec.doneChunks, buf: [], bufBytes: 0, bufFirst: rec.doneChunks, writing: Promise.resolve() });
    this.progress[p.id] = rec.doneChunks * rec.chunkSize;
    this.send(link, { t: 'f-resume', id: p.id, from: rec.doneChunks });
  }

  private onFileData(link: Link, data: unknown) {
    if (!(data instanceof ArrayBuffer)) return;
    const { fileId, index, payload } = decodeChunk(data);
    const inc = this.incoming.get(fileId);
    if (!inc || inc.rec.friendId !== link.friendId) return;
    if (index < inc.next) return; // duplicate after a resume
    if (index > inc.next) {
      // Should not happen on an ordered channel; ask again from what we have.
      this.send(link, { t: 'f-resume', id: fileId, from: inc.next });
      return;
    }
    if (inc.bufBytes === 0) inc.bufFirst = index;
    inc.buf.push(payload.slice());
    inc.bufBytes += payload.length;
    inc.next++;
    this.progress[fileId] = Math.min(inc.rec.size, inc.next * inc.rec.chunkSize);
    this.emit();
    const last = inc.next >= inc.rec.totalChunks;
    if (inc.bufBytes >= SEGMENT_BYTES || last) {
      const seg = { first: inc.bufFirst, parts: inc.buf, count: inc.buf.length };
      inc.buf = [];
      inc.bufBytes = 0;
      inc.writing = inc.writing.then(() => this.writeSegment(link, inc, seg.first, seg.parts, seg.count, last));
    }
  }

  private async writeSegment(link: Link, inc: Incoming, first: number, parts: Uint8Array[], count: number, last: boolean) {
    if (!this.incoming.has(inc.rec.id)) return; // cancelled
    const done = first + count;
    await db.transaction('rw', db.segments, db.files, async () => {
      await db.segments.put({ fileId: inc.rec.id, index: first, firstChunk: first, chunkCount: count, data: new Blob(parts as BlobPart[]) });
      await db.files.update(inc.rec.id, last ? { doneChunks: done, state: 'complete' } : { doneChunks: done });
    });
    inc.rec.doneChunks = done;
    if (last) {
      this.incoming.delete(inc.rec.id);
      delete this.progress[inc.rec.id];
      this.send(link, { t: 'f-done', id: inc.rec.id });
    } else {
      this.send(link, { t: 'f-progress', id: inc.rec.id, done });
    }
    this.emit();
  }

  /** On disconnect: keep whatever complete chunks are buffered so the resume point is as late as possible. */
  private async flushIncoming(fileId: string) {
    const inc = this.incoming.get(fileId);
    if (!inc) return;
    await inc.writing;
    if (inc.buf.length) {
      const first = inc.bufFirst;
      const parts = inc.buf;
      inc.buf = [];
      inc.bufBytes = 0;
      await db.transaction('rw', db.segments, db.files, async () => {
        await db.segments.put({ fileId, index: first, firstChunk: first, chunkCount: parts.length, data: new Blob(parts as BlobPart[]) });
        await db.files.update(fileId, { doneChunks: first + parts.length });
      });
    }
  }
}

function rank(s: string) {
  return ['pending', 'failed', 'sent', 'delivered', 'read'].indexOf(s);
}

function waitForLow(ch: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      ch.removeEventListener('bufferedamountlow', done);
      ch.removeEventListener('close', done);
      resolve();
    };
    ch.addEventListener('bufferedamountlow', done);
    ch.addEventListener('close', done);
  });
}

async function requestWakeLock(): Promise<WakeLockSentinel | undefined> {
  try {
    return await navigator.wakeLock?.request('screen');
  } catch {
    return undefined;
  }
}

export const manager = new Manager();
// Handy for debugging from the browser console and for the end-to-end test.
Object.assign(globalThis, { __pocketLink: manager, __pocketLinkDb: db });

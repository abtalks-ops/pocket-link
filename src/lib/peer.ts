import { decodePairing, describeCandidates, encodePairing, PairingCodeError } from './signal';
import { iceServers } from './settings';

/**
 * One WebRTC link to one phone. Signaling is done by hand: the offer and the answer
 * travel as QR codes, so we wait for ICE gathering to finish before producing a code
 * (no trickle ICE).
 */
export type Phase =
  | 'preparing' // creating offer/answer and gathering network addresses
  | 'show-offer' // offerer: showing QR, waiting to scan the answer
  | 'show-answer' // answerer: showing QR, waiting for the other phone to scan it
  | 'connecting' // ICE checks running
  | 'unstable' // ICE reported "disconnected"; may recover
  | 'open' // data channels open (handshake runs on top)
  | 'closed'
  | 'failed';

export interface Diagnostics {
  local?: ReturnType<typeof describeCandidates>;
  remote?: ReturnType<typeof describeCandidates>;
  ice?: RTCIceConnectionState;
  pair?: string; // e.g. "host ↔ host (udp)"
}

const GATHER_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 25000;

export class PeerSession extends EventTarget {
  readonly pc: RTCPeerConnection;
  readonly role: 'offerer' | 'answerer';
  session = '';
  phase: Phase = 'preparing';
  localCode = '';
  error = '';
  diag: Diagnostics = {};
  ctrl?: RTCDataChannel;
  file?: RTCDataChannel;
  private connectTimer?: ReturnType<typeof setTimeout>;

  private constructor(role: 'offerer' | 'answerer') {
    super();
    this.role = role;
    this.pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc.oniceconnectionstatechange = () => this.onIceState();
    this.pc.onconnectionstatechange = () => this.onConnState();
    if (role === 'offerer') {
      // Negotiated channels with fixed ids would also work; in-band keeps it simple.
      this.attach(this.pc.createDataChannel('ctrl', { ordered: true }));
      this.attach(this.pc.createDataChannel('file', { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => this.attach(e.channel);
    }
  }

  /** Phone A: create the first QR code. */
  static async startOffer(): Promise<PeerSession> {
    const s = new PeerSession('offerer');
    s.session = Math.random().toString(36).slice(2, 8);
    try {
      await s.pc.setLocalDescription(await s.pc.createOffer());
      await s.waitForGathering();
      s.localCode = encodePairing({ type: 'offer', session: s.session, sdp: s.pc.localDescription!.sdp });
      s.diag.local = describeCandidates(s.pc.localDescription!.sdp);
      s.setPhase('show-offer');
    } catch (e) {
      s.fail(`Could not prepare a pairing code: ${(e as Error).message}`);
    }
    return s;
  }

  /** Phone B: scanned A's code, create the reply QR code. */
  static async acceptOffer(code: string): Promise<PeerSession> {
    const p = decodePairing(code);
    if (p.type !== 'offer') throw new PairingCodeError('That is a reply code. Scan the code on the phone that started pairing.');
    const s = new PeerSession('answerer');
    s.session = p.session;
    try {
      s.diag.remote = describeCandidates(p.sdp);
      await s.pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
      await s.pc.setLocalDescription(await s.pc.createAnswer());
      await s.waitForGathering();
      s.localCode = encodePairing({ type: 'answer', session: s.session, sdp: s.pc.localDescription!.sdp });
      s.diag.local = describeCandidates(s.pc.localDescription!.sdp);
      s.setPhase('show-answer');
      s.armConnectTimeout();
    } catch (e) {
      s.fail(`Could not read the pairing code: ${(e as Error).message}`);
    }
    return s;
  }

  /** Phone A: scanned B's reply code. */
  async acceptAnswer(code: string) {
    const p = decodePairing(code);
    if (p.type !== 'answer') throw new PairingCodeError('That is a starting code. Scan the reply code shown on your friend’s phone.');
    if (p.session !== this.session) throw new PairingCodeError('That reply belongs to a different pairing. Ask your friend to scan your current code again.');
    this.diag.remote = describeCandidates(p.sdp);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
    this.setPhase('connecting');
    this.armConnectTimeout();
  }

  close() {
    clearTimeout(this.connectTimer);
    try {
      this.ctrl?.close();
      this.file?.close();
      this.pc.close();
    } catch {
      /* ignore */
    }
    if (this.phase !== 'failed') this.setPhase('closed');
  }

  get isOpen() {
    return this.ctrl?.readyState === 'open' && this.file?.readyState === 'open';
  }

  private attach(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'ctrl') this.ctrl = ch;
    else if (ch.label === 'file') this.file = ch;
    ch.onopen = () => {
      if (this.isOpen) {
        clearTimeout(this.connectTimer);
        this.setPhase('open');
        void this.readSelectedPair();
      }
    };
    ch.onclose = () => {
      if (this.phase === 'open' || this.phase === 'unstable') this.setPhase('closed');
    };
  }

  private waitForGathering(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => this.pc.iceGatheringState === 'complete' && done();
      const t = setTimeout(done, GATHER_TIMEOUT_MS);
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private armConnectTimeout() {
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (!this.isOpen) this.fail(this.explainFailure('timeout'));
    }, CONNECT_TIMEOUT_MS);
  }

  private onIceState() {
    const st = this.pc.iceConnectionState;
    this.diag.ice = st;
    if (st === 'checking' && this.phase === 'show-answer') this.setPhase('connecting');
    if (st === 'disconnected' && this.phase === 'open') this.setPhase('unstable');
    if ((st === 'connected' || st === 'completed') && this.phase === 'unstable') this.setPhase('open');
    if (st === 'failed') this.fail(this.explainFailure('failed'));
    this.emit();
  }

  private onConnState() {
    if (this.pc.connectionState === 'failed') this.fail(this.explainFailure('failed'));
  }

  /** Turn what we know about the candidates into advice a person can act on. */
  explainFailure(kind: 'failed' | 'timeout'): string {
    const { local, remote } = this.diag;
    const lead = kind === 'timeout' ? 'The phones could not reach each other in time.' : 'The direct link between the phones failed.';
    const tips: string[] = [];
    if (this.role === 'answerer' && this.phase === 'show-answer')
      return 'Your friend has not scanned your reply code yet. Keep this screen open and let them scan it, or start over.';
    if (local && local.host === 0 && local.srflx === 0) tips.push('This phone found no network address. Check that Wi-Fi or the hotspot is on.');
    if ((local?.mdns ?? 0) > 0 || (remote?.mdns ?? 0) > 0)
      tips.push('A phone hid its local address (privacy mode), and this network may not pass those hidden names. Allow camera access before pairing, or try one phone’s hotspot.');
    tips.push('Make sure both phones are on the same Wi-Fi, or one is connected to the other’s hotspot.');
    tips.push('Guest and office Wi-Fi often block phones from talking to each other ("client isolation"). A personal hotspot usually works.');
    tips.push('If it keeps failing, turn on "Public STUN" in Settings on both phones and pair again.');
    return [lead, ...tips].join('\n• ');
  }

  private async readSelectedPair() {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      stats.forEach((r) => {
        if (!pairId && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId = r.id;
      });
      const pair = pairId ? stats.get(pairId) : undefined;
      if (pair) {
        const l = stats.get(pair.localCandidateId);
        const r = stats.get(pair.remoteCandidateId);
        this.diag.pair = `${l?.candidateType ?? '?'} ↔ ${r?.candidateType ?? '?'} (${l?.protocol ?? '?'})`;
        this.emit();
      }
    } catch {
      /* stats are best-effort */
    }
  }

  private fail(msg: string) {
    if (this.phase === 'failed' || this.phase === 'closed') return;
    clearTimeout(this.connectTimer);
    this.error = msg;
    this.setPhase('failed');
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }

  private setPhase(p: Phase) {
    if (this.phase === p) return;
    this.phase = p;
    this.emit();
  }

  private emit() {
    this.dispatchEvent(new Event('change'));
  }
}

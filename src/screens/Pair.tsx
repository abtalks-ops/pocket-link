import { useCallback, useEffect, useState } from 'react';
import { manager } from '../lib/manager';
import { useManager } from '../lib/useManager';
import { acquireCamera, releaseCamera } from '../lib/camera';
import { QrCode } from '../components/QrCode';
import { Scanner } from '../components/Scanner';
import type { PeerSession } from '../lib/peer';

type Step = 'choose' | 'start-show' | 'start-scan' | 'join-scan' | 'join-show';

export function Pair({ onBack }: { onBack: () => void }) {
  const snap = useManager();
  const peer = snap.pairing;
  const [step, setStep] = useState<Step>('choose');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [scanKey, setScanKey] = useState(0);

  useEffect(() => () => {
    manager.cancelPairing();
    releaseCamera();
  }, []);

  const start = async () => {
    setErr('');
    setBusy(true);
    await acquireCamera().catch(() => {}); // see camera.ts: improves local address discovery
    await manager.startPairing();
    setBusy(false);
    setStep('start-show');
  };

  const onAnswer = useCallback(async (code: string) => {
    setErr('');
    try {
      await manager.completePairing(code);
      releaseCamera();
    } catch (e) {
      setErr((e as Error).message);
      setScanKey((k) => k + 1);
    }
  }, []);

  const onOffer = useCallback(async (code: string) => {
    setErr('');
    setBusy(true);
    try {
      await manager.joinPairing(code);
      setStep('join-show');
    } catch (e) {
      setErr((e as Error).message);
      setScanKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }, []);

  const restart = () => {
    manager.cancelPairing();
    setErr('');
    setStep('choose');
  };

  return (
    <div className="screen">
      <header className="bar">
        <button className="icon" onClick={onBack} aria-label="Back">‹</button>
        <h1>Pair with a friend</h1>
      </header>
      <main className="pad">
        {step === 'choose' && (
          <>
            <p className="lead">Stand next to your friend. Both phones need to be on the same Wi-Fi, or one phone on the other’s hotspot.</p>
            <p className="muted">One of you starts, the other joins. You will each scan one code.</p>
            <button className="primary big" disabled={busy} onClick={start}>
              {busy ? 'Preparing…' : 'Start: show my code'}
            </button>
            <button className="big" onClick={() => { void acquireCamera().catch(() => {}); setStep('join-scan'); }}>
              Join: scan my friend’s code
            </button>
          </>
        )}

        {step === 'start-show' && peer && (
          <>
            <StepLabel n={1} text="Let your friend scan this code" />
            {peer.localCode ? <QrCode value={peer.localCode} /> : null}
            <PhaseStatus peer={peer} />
            {peer.phase === 'show-offer' && (
              <button className="primary big" onClick={() => setStep('start-scan')}>
                Next: scan their reply code
              </button>
            )}
          </>
        )}

        {step === 'start-scan' && peer && (
          <>
            <StepLabel n={2} text="Scan the reply code on your friend’s phone" />
            {peer.phase === 'show-offer' && <Scanner key={scanKey} onCode={onAnswer} hint="Point the camera at your friend’s screen." />}
            <PhaseStatus peer={peer} />
            {peer.phase === 'show-offer' && (
              <button className="link" onClick={() => setStep('start-show')}>Show my code again</button>
            )}
          </>
        )}

        {step === 'join-scan' && (
          <>
            <StepLabel n={1} text="Scan the code on your friend’s phone" />
            {busy ? <p className="status">Reading code and preparing your reply…</p> : <Scanner key={scanKey} onCode={onOffer} hint="Ask your friend to tap Start." />}
          </>
        )}

        {step === 'join-show' && peer && (
          <>
            <StepLabel n={2} text="Now let your friend scan this reply" />
            {peer.localCode && peer.phase !== 'failed' ? <QrCode value={peer.localCode} /> : null}
            <PhaseStatus peer={peer} />
          </>
        )}

        {err && <p className="error">{err}</p>}
        {peer?.phase === 'failed' && (
          <button className="primary" onClick={restart}>Start over</button>
        )}
      </main>
    </div>
  );
}

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <p className="step">
      <span className="badge">{n}/2</span> {text}
    </p>
  );
}

const PHASE_TEXT: Record<PeerSession['phase'], string> = {
  preparing: 'Finding this phone’s network address…',
  'show-offer': 'Waiting for your friend to scan.',
  'show-answer': 'Waiting for your friend to scan your reply…',
  connecting: 'Connecting phone to phone…',
  unstable: 'Connection is unstable…',
  open: 'Connected. Checking identity…',
  closed: 'Connection closed.',
  failed: 'Could not connect.',
};

export function PhaseStatus({ peer }: { peer: PeerSession }) {
  const { phase, error, diag } = peer;
  const [first, ...tips] = error.split('\n• ');
  return (
    <div className={`status ${phase === 'failed' ? 'bad' : phase === 'open' ? 'good' : ''}`} role="status">
      <p>{PHASE_TEXT[phase]}</p>
      {phase === 'failed' && (
        <>
          <p>{first}</p>
          {tips.length > 0 && <ul>{tips.map((t) => <li key={t}>{t}</li>)}</ul>}
        </>
      )}
      {diag.local && (
        <details className="diag">
          <summary>Connection details</summary>
          <p>
            This phone: {diag.local.ip} local IP, {diag.local.mdns} hidden (mDNS), {diag.local.srflx} via STUN
          </p>
          {diag.remote && (
            <p>
              Friend: {diag.remote.ip} local IP, {diag.remote.mdns} hidden (mDNS), {diag.remote.srflx} via STUN
            </p>
          )}
          {diag.ice && <p>ICE state: {diag.ice}</p>}
          {diag.pair && <p>Route: {diag.pair}</p>}
        </details>
      )}
    </div>
  );
}

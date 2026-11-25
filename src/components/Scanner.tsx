import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { acquireCamera } from '../lib/camera';

/** Camera QR scanner with a paste-the-code fallback (useful on laptops and for testing). */
export function Scanner({ onCode, hint }: { onCode: (code: string) => void; hint: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const [paste, setPaste] = useState('');
  const done = useRef(false);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    let stopped = false;
    acquireCamera()
      .then((s) => {
        if (stopped || !video.current) return;
        video.current.srcObject = s;
        void video.current.play().catch(() => {});
        const tick = (t: number) => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          const v = video.current;
          if (!v || v.readyState < 2 || t - last < 120 || done.current) return;
          last = t;
          // Scan a centred square, downscaled, to keep each frame cheap.
          const side = Math.min(v.videoWidth, v.videoHeight);
          const size = Math.min(side, 720);
          canvas.width = canvas.height = size;
          ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
          const img = ctx.getImageData(0, 0, size, size);
          const res = jsQR(img.data, size, size, { inversionAttempts: 'dontInvert' });
          if (res?.data?.startsWith('PL1')) {
            done.current = true;
            navigator.vibrate?.(60);
            onCode(res.data);
          }
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e: Error) => setErr(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in your browser settings, or paste the code below.' : e.message));
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (video.current) video.current.srcObject = null;
    };
  }, [onCode]);

  return (
    <div className="scanner">
      <p className="hint">{hint}</p>
      {err ? <p className="error">{err}</p> : <video ref={video} playsInline muted className="viewfinder" />}
      <details className="paste">
        <summary>No camera? Paste the code instead</summary>
        <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="PL1…" rows={3} aria-label="Pairing code" />
        <button disabled={!paste.trim()} onClick={() => onCode(paste.trim())}>
          Use this code
        </button>
      </details>
    </div>
  );
}

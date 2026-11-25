import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

export function QrCode({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (ref.current)
      QRCode.toCanvas(ref.current, value, { errorCorrectionLevel: 'L', margin: 2, width: Math.min(340, window.innerWidth - 48) }).catch(
        console.error,
      );
  }, [value]);
  return (
    <div className="qr">
      <canvas ref={ref} aria-label="Pairing QR code" />
      <button
        className="link"
        onClick={async () => {
          await navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy code as text'}
      </button>
    </div>
  );
}

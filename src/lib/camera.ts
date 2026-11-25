/**
 * Camera access for QR scanning.
 *
 * We open the camera at the *start* of pairing, before any WebRTC offer/answer is made,
 * and keep it open until pairing ends. Chromium-based browsers only reveal a phone's real
 * local IP address in ICE candidates when the page has active camera/mic access; otherwise
 * they replace it with a random "*.local" mDNS name, which some Wi-Fi networks and hotspots
 * cannot resolve. Holding the stream during pairing avoids that on the most common phones.
 */
let stream: MediaStream | undefined;
let pending: Promise<MediaStream> | undefined;

export async function acquireCamera(): Promise<MediaStream> {
  if (stream && stream.getVideoTracks().some((t) => t.readyState === 'live')) return stream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera here. The page must be opened over HTTPS.');
  pending ??= navigator.mediaDevices
    .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then((s) => (stream = s))
    .finally(() => (pending = undefined));
  return pending;
}

export function releaseCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = undefined;
}

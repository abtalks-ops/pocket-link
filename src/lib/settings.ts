const KEY = 'pocket-link:settings';

export interface Settings {
  /** Use a public STUN server. Off by default so nothing leaves the local network. */
  useStun: boolean;
  stunUrl: string;
}

const defaults: Settings = { useStun: false, stunUrl: 'stun:stun.l.google.com:19302' };

export function getSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Partial<Settings>) {
  localStorage.setItem(KEY, JSON.stringify({ ...getSettings(), ...s }));
}

export function iceServers(): RTCIceServer[] {
  const s = getSettings();
  return s.useStun && s.stunUrl ? [{ urls: s.stunUrl }] : [];
}

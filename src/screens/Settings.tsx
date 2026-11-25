import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../lib/settings';
import { manager } from '../lib/manager';
import { renameIdentity } from '../lib/identity';
import { bytes } from '../lib/format';

export function Settings({ onBack }: { onBack: () => void }) {
  const [s, setS] = useState(getSettings());
  const [name, setName] = useState(manager.me?.name ?? '');
  const [usage, setUsage] = useState<string>('');
  const [persisted, setPersisted] = useState<boolean>();
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setUsage(`${bytes(e.usage ?? 0)} used of about ${bytes(e.quota ?? 0)}`));
    navigator.storage?.persisted?.().then(setPersisted);
  }, []);
  const update = (p: Partial<typeof s>) => {
    saveSettings(p);
    setS(getSettings());
  };
  return (
    <div className="screen">
      <header className="bar">
        <button className="icon" onClick={onBack} aria-label="Back">‹</button>
        <h1>Settings</h1>
      </header>
      <main className="pad stack">
        <label htmlFor="nm">Your name</label>
        <div className="inline">
          <input id="nm" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <button
            disabled={!name.trim() || name === manager.me?.name}
            onClick={async () => {
              await renameIdentity(name.trim());
              if (manager.me) manager.me.name = name.trim();
              manager.broadcastName(name.trim());
            }}
          >
            Save
          </button>
        </div>
        <p className="muted small">Your ID: {manager.me?.id.match(/.{1,4}/g)?.join(' ')}</p>

        <h2>Connection</h2>
        <label className="toggle">
          <input type="checkbox" checked={s.useStun} onChange={(e) => update({ useStun: e.target.checked })} />
          <span>
            Use public STUN server
            <span className="muted small block">
              Off by default, so pairing never contacts the internet. Turn it on (on both phones) if pairing keeps failing on your network. Messages still go directly phone to phone.
            </span>
          </span>
        </label>
        {s.useStun && <input value={s.stunUrl} onChange={(e) => update({ stunUrl: e.target.value })} aria-label="STUN server URL" />}

        <h2>Storage</h2>
        <p className="muted small">{usage}</p>
        {persisted === false && (
          <button onClick={() => navigator.storage.persist().then(setPersisted)}>Keep my chats safe from automatic cleanup</button>
        )}
        {persisted && <p className="muted small">Storage is persistent. The browser will not clear it automatically.</p>}
        <p className="muted small">Chats and files live only on this phone. Uninstalling the app or clearing site data deletes them.</p>
      </main>
    </div>
  );
}

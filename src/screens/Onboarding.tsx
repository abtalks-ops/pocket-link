import { useState } from 'react';
import { createIdentity } from '../lib/identity';
import type { Identity } from '../lib/db';

export function Onboarding({ onDone }: { onDone: (me: Identity) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="screen center">
      <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={88} height={88} />
      <h1>Pocket Link</h1>
      <p className="lead">Chat and share photos with friends next to you. Phone to phone, no accounts, no server.</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          navigator.storage?.persist?.().catch(() => {});
          onDone(await createIdentity(name.trim().slice(0, 40)));
        }}
      >
        <label htmlFor="name">What should friends see as your name?</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus maxLength={40} />
        <button className="primary big" disabled={!name.trim() || busy}>
          {busy ? 'Creating your key…' : 'Get started'}
        </button>
      </form>
    </div>
  );
}

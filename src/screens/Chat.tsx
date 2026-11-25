import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { assembleFile, db, deleteFriend, type FileRecord, type Message } from '../lib/db';
import { manager } from '../lib/manager';
import { useManager } from '../lib/useManager';
import { bytes, time } from '../lib/format';
import { safetyCode } from '../lib/identity';
import { MAX_FILE_BYTES } from '../lib/protocol';

export function Chat({ friendId, go }: { friendId: string; go: (p: string) => void }) {
  const snap = useManager();
  const friend = useLiveQuery(() => db.friends.get(friendId), [friendId]);
  const messages = useLiveQuery(() => db.messages.where('[friendId+ts]').between([friendId, 0], [friendId, Infinity]).toArray(), [friendId]);
  const files = useLiveQuery(async () => {
    const list = await db.files.where('friendId').equals(friendId).toArray();
    return Object.fromEntries(list.map((f) => [f.id, f]));
  }, [friendId]);
  const link = snap.links[friendId];
  const state = link?.state ?? 'offline';
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingSent = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Read receipts: mark as read while this chat is on screen.
  useEffect(() => {
    manager.viewing = friendId;
    const onVis = () => {
      manager.viewing = document.visibilityState === 'visible' ? friendId : undefined;
      if (manager.viewing) void manager.markRead(friendId);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (manager.viewing === friendId) manager.viewing = undefined;
    };
  }, [friendId]);
  useEffect(() => {
    if (document.visibilityState === 'visible') void manager.markRead(friendId);
  }, [friendId, messages?.length, state]);
  useEffect(() => {
    // Newer browsers return a Promise from scrollIntoView, so do not return it from the effect.
    void endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, link?.typing]);

  if (friend === undefined && messages !== undefined) {
    return (
      <div className="screen center">
        <p>This chat no longer exists.</p>
        <button onClick={() => go('/')}>Back</button>
      </div>
    );
  }

  const onType = (v: string) => {
    setText(v);
    const now = Date.now();
    if (v && now - typingSent.current > 2500) {
      typingSent.current = now;
      manager.setTyping(friendId, true);
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typingSent.current = 0;
      manager.setTyping(friendId, false);
    }, 4000);
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    typingSent.current = 0;
    await manager.sendText(friendId, t);
  };

  const pickFiles = async (list: FileList | null) => {
    setErr('');
    for (const f of Array.from(list ?? [])) {
      if (f.size > MAX_FILE_BYTES) {
        setErr(`${f.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      await manager.sendFile(friendId, f).catch((e: Error) => setErr(e.message));
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <div className="screen chat">
      <header className="bar">
        <button className="icon" onClick={() => go('/')} aria-label="Back">‹</button>
        <span className={`avatar small ${state}`}>{friend?.name.slice(0, 1).toUpperCase()}</span>
        <div className="grow">
          <h1>{friend?.name}</h1>
          <p className="sub">{link?.typing ? 'typing…' : STATE_TEXT[state]}</p>
        </div>
        <button className="icon" onClick={() => setMenu((m) => !m)} aria-label="More">⋯</button>
      </header>
      {menu && friend && manager.me && (
        <div className="menu">
          <p className="muted small">
            Safety code: <strong>{safetyCode(manager.me.id, friend.id)}</strong>. It matches on both phones if you are talking to the right person.
          </p>
          {link?.pair && <p className="muted small">Route: {link.pair}</p>}
          {state !== 'offline' && <button onClick={() => manager.disconnect(friendId)}>Disconnect</button>}
          <button
            className="danger"
            onClick={async () => {
              if (!confirm(`Delete ${friend.name} and your whole chat history with them from this phone?`)) return;
              manager.disconnect(friendId);
              await deleteFriend(friendId);
              go('/');
            }}
          >
            Delete friend and history
          </button>
        </div>
      )}
      {state === 'offline' && (
        <div className="banner">
          <span>Not connected. Messages you write will be sent when you pair again.</span>
          <button className="primary small" onClick={() => go('/pair')}>Pair again</button>
        </div>
      )}
      {state === 'unstable' && <div className="banner warn">Connection is unstable. Keep the phones close and the app open.</div>}
      <main className="messages">
        {messages?.map((m) => <Bubble key={m.id} m={m} file={m.fileId ? files?.[m.fileId] : undefined} progress={m.fileId ? snap.progress[m.fileId] : undefined} />)}
        {link?.typing && <div className="bubble them typing"><span /><span /><span /></div>}
        <div ref={endRef} />
      </main>
      {err && <p className="error pad">{err}</p>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void pickFiles(e.target.files)} />
        <button type="button" className="icon" onClick={() => fileInput.current?.click()} aria-label="Attach photo or file">＋</button>
        <input className="grow" value={text} onChange={(e) => onType(e.target.value)} placeholder="Message" aria-label="Message" enterKeyHint="send" />
        <button className="primary" disabled={!text.trim()} aria-label="Send">Send</button>
      </form>
    </div>
  );
}

const STATE_TEXT = { online: 'Connected', handshake: 'Connecting…', unstable: 'Unstable connection', offline: 'Not connected' } as const;
const TICKS: Record<Message['status'], string> = { pending: '🕓', failed: '!', sent: '✓', delivered: '✓✓', read: '✓✓' };

function Bubble({ m, file, progress }: { m: Message; file?: FileRecord; progress?: number }) {
  return (
    <div className={`bubble ${m.from}`}>
      {m.kind === 'text' ? <p className="text">{m.text}</p> : file ? <FileView f={file} progress={progress} /> : <p className="muted">File</p>}
      <span className="stamp">
        {time(m.ts)}
        {m.from === 'me' && <span className={`ticks ${m.status}`} title={m.status}> {TICKS[m.status]}</span>}
      </span>
    </div>
  );
}

function FileView({ f, progress }: { f: FileRecord; progress?: number }) {
  const [url, setUrl] = useState<string>();
  const isImage = f.mime.startsWith('image/');
  const isVideo = f.mime.startsWith('video/');
  const ready = f.direction === 'out' || f.state === 'complete';
  useEffect(() => {
    if (!ready) return;
    let u: string | undefined;
    let alive = true;
    void assembleFile(f.id).then((b) => {
      if (b && alive) setUrl((u = URL.createObjectURL(b)));
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [f.id, ready]);

  const doneBytes = progress ?? Math.min(f.size, f.doneChunks * (f.chunkSize || 1));
  const pct = f.size ? Math.round((doneBytes / f.size) * 100) : 100;
  const moving = f.state === 'transferring' || f.state === 'paused' || f.state === 'pending';

  return (
    <div className="file">
      {url && isImage && <img src={url} alt={f.name} loading="lazy" />}
      {url && isVideo && <video src={url} controls playsInline preload="metadata" />}
      <div className="file-row">
        <span className="file-name">{f.name}</span>
        <span className="muted small">{bytes(f.size)}</span>
      </div>
      {moving && f.state !== 'complete' && (
        <>
          <div className="progress" aria-label={`${pct}%`}><div style={{ width: `${pct}%` }} /></div>
          <div className="file-row small">
            <span className="muted">
              {f.state === 'paused' ? `Paused at ${pct}%. Resumes when you reconnect.` : f.state === 'pending' ? 'Waiting to send…' : `${pct}%`}
            </span>
            <button className="link" onClick={() => void manager.cancelFile(f.id)}>Cancel</button>
          </div>
        </>
      )}
      {f.state === 'cancelled' && <p className="muted small">Cancelled</p>}
      {f.state === 'failed' && <p className="error small">Failed</p>}
      {url && f.state === 'complete' && f.direction === 'in' && (
        <a className="link" href={url} download={f.name}>Save to device</a>
      )}
    </div>
  );
}

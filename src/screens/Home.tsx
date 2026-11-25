import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { useManager } from '../lib/useManager';
import { time } from '../lib/format';

export function Home({ go }: { go: (p: string) => void }) {
  const snap = useManager();
  const friends = useLiveQuery(() => db.friends.orderBy('lastSeen').reverse().toArray(), []);
  const lastMsgs = useLiveQuery(async () => {
    const out: Record<string, { text: string; ts: number; unread: number }> = {};
    for (const f of (await db.friends.toArray()) ?? []) {
      const all = await db.messages.where('[friendId+ts]').between([f.id, 0], [f.id, Infinity]).toArray();
      const last = all[all.length - 1];
      const unread = all.filter((m) => m.from === 'them' && m.status !== 'read').length;
      if (last) out[f.id] = { text: last.kind === 'file' ? '📎 File' : last.text ?? '', ts: last.ts, unread };
    }
    return out;
  }, []);

  return (
    <div className="screen">
      <header className="bar">
        <h1>Pocket Link</h1>
        <button className="icon" onClick={() => go('/settings')} aria-label="Settings">⚙</button>
      </header>
      <main>
        {friends && friends.length === 0 && (
          <div className="empty pad">
            <p className="lead">No friends yet.</p>
            <p className="muted">Pair with someone next to you by scanning each other’s QR codes.</p>
          </div>
        )}
        <ul className="list">
          {friends?.map((f) => {
            const st = snap.links[f.id]?.state ?? 'offline';
            const lm = lastMsgs?.[f.id];
            return (
              <li key={f.id}>
                <button className="row" onClick={() => go(`/chat/${f.id}`)}>
                  <span className={`avatar ${st}`}>{f.name.slice(0, 1).toUpperCase()}</span>
                  <span className="grow">
                    <span className="name">{f.name}</span>
                    <span className="preview">{snap.links[f.id]?.typing ? 'typing…' : lm?.text ?? (st === 'online' ? 'Connected' : 'Not connected')}</span>
                  </span>
                  <span className="meta">
                    {lm && <span className="muted small">{time(lm.ts)}</span>}
                    {lm && lm.unread > 0 && <span className="unread">{lm.unread}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </main>
      <footer className="pad">
        <button className="primary big" onClick={() => go('/pair')}>Pair with a friend</button>
      </footer>
    </div>
  );
}

import { lazy, Suspense, useEffect, useState } from 'react';
import { loadIdentity } from './lib/identity';
import { manager } from './lib/manager';
import { useRoute } from './lib/useManager';
import type { Identity } from './lib/db';
import { Onboarding } from './screens/Onboarding';
import { Home } from './screens/Home';
import { Chat } from './screens/Chat';
import { Settings } from './screens/Settings';

// QR generation and scanning (jsQR) are only needed while pairing, so load them on demand.
const Pair = lazy(() => import('./screens/Pair').then((m) => ({ default: m.Pair })));

export function App() {
  const [me, setMe] = useState<Identity | null>();
  const [route, go] = useRoute();

  useEffect(() => {
    loadIdentity().then((i) => {
      manager.me = i;
      setMe(i ?? null);
    });
    manager.onPaired = (id) => go(`/chat/${id}`);
  }, []);

  if (me === undefined) return null;
  if (me === null)
    return (
      <Onboarding
        onDone={(i) => {
          manager.me = i;
          setMe(i);
        }}
      />
    );

  const back = () => go('/');
  switch (route[0]) {
    case 'pair':
      return (
        <Suspense fallback={null}>
          <Pair onBack={back} />
        </Suspense>
      );
    case 'chat':
      return <Chat key={route[1]} friendId={route[1]} go={go} />;
    case 'settings':
      return <Settings onBack={back} />;
    default:
      return <Home go={go} />;
  }
}

import { useSyncExternalStore } from 'react';
import { manager } from './manager';

export function useManager() {
  return useSyncExternalStore(manager.subscribe, manager.snapshot);
}

export function useRoute(): [string[], (path: string) => void] {
  const hash = useSyncExternalStore(
    (fn) => (window.addEventListener('hashchange', fn), () => window.removeEventListener('hashchange', fn)),
    () => location.hash,
  );
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return [parts, (path: string) => (location.hash = path)];
}

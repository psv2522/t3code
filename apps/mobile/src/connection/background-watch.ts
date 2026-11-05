type Listener = () => void;

let active = false;
const activeListeners = new Set<Listener>();
const nudgeListeners = new Set<Listener>();

export function isBackgroundWatchActive(): boolean {
  return active;
}

export function setBackgroundWatchActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of activeListeners) listener();
}

export function subscribeBackgroundWatchActive(listener: Listener): () => void {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

export function nudgeConnections(): void {
  for (const listener of nudgeListeners) listener();
}

export function subscribeConnectionNudges(listener: Listener): () => void {
  nudgeListeners.add(listener);
  return () => {
    nudgeListeners.delete(listener);
  };
}

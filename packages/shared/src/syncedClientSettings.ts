import type { SyncedClientSettingEntry, SyncedClientSettings } from "@t3tools/contracts/settings";

export function compareSyncedClientSettingEntries(
  left: SyncedClientSettingEntry,
  right: SyncedClientSettingEntry,
): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  const a = JSON.stringify(left.value) ?? "";
  const b = JSON.stringify(right.value) ?? "";
  return a === b ? 0 : a > b ? 1 : -1;
}

export function mergeSyncedClientSettings(
  current: SyncedClientSettings,
  patch: SyncedClientSettings,
): SyncedClientSettings {
  let next = current;
  for (const [key, entry] of Object.entries(patch)) {
    const previous = Object.hasOwn(next, key) ? next[key] : undefined;
    if (previous && compareSyncedClientSettingEntries(entry, previous) <= 0) continue;
    if (next === current) next = { ...current };
    Object.defineProperty(next, key, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return next;
}

const SNAPSHOT_CHARS_PER_MS = 64;
const MAX_SNAPSHOT_FLUSH_MS = 1_000;

// Each flush ships and persists the whole text, so the delay grows with its length to keep
// streaming cost linear instead of quadratic in the final size.
export function textSnapshotFlushDelayMs(baseMs: number, textLength: number): number {
  const scaled = Math.min(MAX_SNAPSHOT_FLUSH_MS, Math.ceil(textLength / SNAPSHOT_CHARS_PER_MS));
  return Math.max(1, baseMs, scaled);
}

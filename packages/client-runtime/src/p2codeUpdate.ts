// @effect-diagnostics globalTimers:off - Client polling runs outside an Effect runtime.
import {
  isP2codeUpdateRunning,
  type P2codeUpdateAction,
  type P2codeUpdateResult,
} from "@t3tools/contracts";

export type P2codeUpdateCall = (action: P2codeUpdateAction) => Promise<P2codeUpdateResult>;

const WATCH_INTERVAL_MS = 2_000;
const WATCH_MAX_POLLS = 600;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export type P2codeCheckOutcome =
  | { readonly kind: "up-to-date" }
  | { readonly kind: "dirty" }
  | { readonly kind: "running" }
  | { readonly kind: "available"; readonly changes: ReadonlyArray<string> };

export function resolveP2codeCheck(result: P2codeUpdateResult): P2codeCheckOutcome {
  if (isP2codeUpdateRunning(result.phase)) return { kind: "running" };
  if (result.dirty === true) return { kind: "dirty" };
  const upstreamCommits = result.upstreamCommits ?? 0;
  const changes = [
    ...(upstreamCommits > 0 ? [`${plural(upstreamCommits, "new upstream commit")}`] : []),
    ...(result.localChanges === true ? ["p2code changes made since the last install"] : []),
  ];
  return changes.length === 0 ? { kind: "up-to-date" } : { kind: "available", changes };
}

export function describeP2codeUpdate(result: P2codeUpdateResult): string | null {
  switch (result.phase) {
    case "syncing":
      return "Syncing with upstream…";
    case "building":
      return "Building the update…";
    case "installing":
      return "Installing. T3 Code restarts…";
    case "conflict":
      return "Merge conflicts: a thread is resolving them…";
    case "failed":
      return result.message ?? "The update failed.";
    case "done":
    case "idle":
      return null;
  }
}

/**
 * Follows a started update to its end. Polling errors are expected while the server restarts
 * to install, so they only delay the next poll. Returns null when aborted or out of polls.
 */
export async function watchP2codeUpdate(input: {
  readonly call: P2codeUpdateCall;
  readonly onProgress: (result: P2codeUpdateResult) => void;
  readonly signal: AbortSignal;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<P2codeUpdateResult | null> {
  const wait = input.wait ?? waitFor;
  for (let poll = 0; poll < WATCH_MAX_POLLS; poll++) {
    const result = await input.call("status").catch(() => null);
    if (input.signal.aborted) return null;
    if (result !== null) {
      input.onProgress(result);
      if (!isP2codeUpdateRunning(result.phase)) return result;
    }
    await wait(WATCH_INTERVAL_MS, input.signal);
  }
  return null;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

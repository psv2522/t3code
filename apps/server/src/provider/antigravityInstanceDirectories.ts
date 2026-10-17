import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Path from "effect/Path";

export interface AntigravityInstanceDirectories {
  readonly profile: string;
  /** Keep beside the profile: 120-character archive members under its longer name would exceed Windows' 260-character limit. */
  readonly runtimeTemp: string;
}

/** Hashes the instance ID so case-only differences stay separate on case-insensitive filesystems. */
export const resolveAntigravityInstanceDirectories = Effect.fn(
  "resolveAntigravityInstanceDirectories",
)(function* (stateDir: string, instanceId: ProviderInstanceId) {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const key = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(instanceId)));
  return {
    profile: path.join(stateDir, "providers", "antigravity", key),
    runtimeTemp: path.join(stateDir, "antigravity-tmp", key.slice(0, 12)),
  } satisfies AntigravityInstanceDirectories;
});

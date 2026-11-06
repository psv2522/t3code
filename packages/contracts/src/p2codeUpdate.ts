import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const P2codeUpdateAction = Schema.Literals(["check", "status", "start"]);
export type P2codeUpdateAction = typeof P2codeUpdateAction.Type;

export const P2codeUpdateInput = Schema.Struct({ action: P2codeUpdateAction });
export type P2codeUpdateInput = typeof P2codeUpdateInput.Type;

export const P2codeUpdatePhase = Schema.Literals([
  "idle",
  "syncing",
  "building",
  "installing",
  "conflict",
  "done",
  "failed",
]);
export type P2codeUpdatePhase = typeof P2codeUpdatePhase.Type;

export const P2codeUpdateResult = Schema.Struct({
  phase: P2codeUpdatePhase,
  message: Schema.NullOr(Schema.String),
  /** The thread resolving rebase conflicts, while the phase is `conflict`. */
  threadId: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  /** Present for `check` only. */
  upstreamCommits: Schema.NullOr(NonNegativeInt),
  localChanges: Schema.NullOr(Schema.Boolean),
  dirty: Schema.NullOr(Schema.Boolean),
});
export type P2codeUpdateResult = typeof P2codeUpdateResult.Type;

export class P2codeUpdateError extends Schema.TaggedError<P2codeUpdateError>()(
  "P2codeUpdateError",
  { reason: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.reason;
  }
}

export const isP2codeUpdateRunning = (phase: P2codeUpdatePhase) =>
  phase === "syncing" || phase === "building" || phase === "installing";

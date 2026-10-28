import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const isProxyCooldown = Schema.is(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literal("model_cooldown"), reset_seconds: Schema.Number }),
  }),
);

export function proxyCooldownResetAt(
  message: string | undefined,
  now: DateTime.Utc,
): string | null {
  if (!message) return null;
  try {
    const body: unknown = JSON.parse(extractJsonObject(message));
    if (
      !isProxyCooldown(body) ||
      !Number.isSafeInteger(body.error.reset_seconds) ||
      body.error.reset_seconds <= 0
    )
      return null;
    const resetMs = DateTime.toEpochMillis(now) + body.error.reset_seconds * 1000;
    return resetMs < 8.64e15 ? DateTime.formatIso(DateTime.makeUnsafe(resetMs)) : null;
  } catch {
    return null;
  }
}

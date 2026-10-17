import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";

describe("makeProviderTextDeltaCoalescer", () => {
  it.effect("flushes long text snapshots less often so streaming stays linear", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emitted = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
        const coalescer = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: 50,
          emit: (update) => Ref.update(emitted, (current) => [...current, update]),
        });

        yield* coalescer.append({ turnId: "t", itemId: "short", delta: "hello" });
        yield* TestClock.adjust("50 millis");
        assert.deepStrictEqual(
          (yield* Ref.get(emitted)).map((update) => update.text),
          ["hello"],
        );

        yield* coalescer.append({ turnId: "t", itemId: "long", delta: "x".repeat(32_000) });
        yield* TestClock.adjust("50 millis");
        assert.strictEqual((yield* Ref.get(emitted)).length, 1);
        yield* TestClock.adjust("450 millis");
        assert.strictEqual((yield* Ref.get(emitted)).at(-1)?.text.length, 32_000);
      }),
    ),
  );
});

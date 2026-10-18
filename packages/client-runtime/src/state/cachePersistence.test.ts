import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { CachePersistencePolicy } from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";

const startPersistence = Effect.fn("TestCachePersistence.start")(function* (
  policy?: typeof CachePersistencePolicy.Service,
) {
  const queue = yield* Queue.sliding<number>(1);
  const saved = yield* SubscriptionRef.make<ReadonlyArray<number>>([]);
  const run = runCachePersistence(queue, (value: number) =>
    SubscriptionRef.update(saved, (all) => [...all, value]),
  );
  yield* (
    policy === undefined ? run : run.pipe(Effect.provideService(CachePersistencePolicy, policy))
  ).pipe(Effect.forkScoped);
  const advance = (duration: Parameters<typeof TestClock.adjust>[0]) =>
    TestClock.adjust(duration).pipe(Effect.andThen(Effect.yieldNow));
  return {
    advance,
    offer: (value: number) => Queue.offer(queue, value).pipe(Effect.andThen(Effect.yieldNow)),
    saved: SubscriptionRef.get(saved),
    awaitSaved: (count: number) =>
      SubscriptionRef.changes(saved).pipe(
        Stream.filter((all) => all.length >= count),
        Stream.runHead,
      ),
  };
});

describe("runCachePersistence", () => {
  it.effect("writes at most once per default interval", () =>
    Effect.gen(function* () {
      const persistence = yield* startPersistence();

      yield* persistence.offer(1);
      yield* persistence.advance("500 millis");
      yield* persistence.awaitSaved(1);

      yield* persistence.offer(2);
      yield* persistence.offer(3);
      yield* persistence.advance("9999 millis");
      expect(yield* persistence.saved).toEqual([1]);
      yield* persistence.advance("1 millis");
      yield* persistence.awaitSaved(2);
      expect(yield* persistence.saved).toEqual([1, 3]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("uses the injected interval and writes pending data on a flush", () =>
    Effect.gen(function* () {
      const flushes = yield* Queue.unbounded<void>();
      const persistence = yield* startPersistence({
        interval: "30 seconds",
        flushes: Stream.fromQueue(flushes),
      });

      yield* persistence.offer(1);
      yield* persistence.advance("500 millis");
      yield* persistence.awaitSaved(1);
      yield* persistence.offer(2);
      yield* persistence.advance("10 seconds");
      expect(yield* persistence.saved).toEqual([1]);

      yield* Queue.offer(flushes, undefined);
      yield* persistence.awaitSaved(2);
      expect(yield* persistence.saved).toEqual([1, 2]);

      yield* persistence.offer(3);
      yield* persistence.advance("29999 millis");
      expect(yield* persistence.saved).toEqual([1, 2]);
      yield* persistence.advance("1 millis");
      yield* persistence.awaitSaved(3);
      expect(yield* persistence.saved).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

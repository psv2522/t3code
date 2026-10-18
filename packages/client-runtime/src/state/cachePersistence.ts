import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CachePersistencePolicy } from "../platform/persistence.ts";

// Do not debounce upstream: its consumer can retain an older snapshot during a save.
export const runCachePersistence = Effect.fn("runCachePersistence")(function* <A, E, R>(
  queue: Queue.Queue<A>,
  persist: (value: A) => Effect.Effect<void, E, R>,
) {
  const policy = yield* CachePersistencePolicy;
  const flushRequests = yield* Queue.sliding<void>(1);
  yield* policy.flushes.pipe(
    Stream.runForEach(() => Queue.offer(flushRequests, undefined)),
    Effect.forkChild,
  );
  let next = yield* Queue.take(queue);
  yield* Effect.sleep("500 millis");
  next = Option.getOrElse(yield* Queue.poll(queue), () => next);
  while (true) {
    yield* persist(next);
    yield* Queue.take(flushRequests).pipe(
      Effect.timeoutOrElse({ duration: policy.interval, orElse: () => Effect.void }),
    );
    next = yield* Queue.take(queue);
  }
});

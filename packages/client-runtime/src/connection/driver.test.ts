import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const LABEL = "Test environment";

const LAN_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: LABEL,
  connectionId: "bearer:lan",
});
const LAN_ROUTE: ConnectionRoute = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: ENVIRONMENT_ID,
      label: LABEL,
      httpBaseUrl: "http://172.20.10.2:3773/",
      wsBaseUrl: "ws://172.20.10.2:3773/",
    }),
  ),
};
const RELAY_ROUTE: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: LABEL }),
  profile: Option.none(),
};

const LAN_THEN_RELAY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  alternateRoutes: [RELAY_ROUTE],
  enabled: true,
};
const LAN_ONLY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  enabled: true,
};

const leaseFor = (route: ConnectionRoute) =>
  ({
    prepared: { target: route.target },
    session: {},
  }) as unknown as ConnectionDriver.EnvironmentConnectionLease;

const answered = () => Effect.succeed<ConnectionDriver.RouteCheck>("answered");

it.effect("falls back to T3 Connect when a LAN route answers the probe and then hangs", () =>
  Effect.gen(function* () {
    const relayAttempted = yield* Ref.make(false);
    const connecting = yield* Effect.scoped(
      ConnectionDriver.connectOverRoutes(LAN_THEN_RELAY, answered, (route) =>
        route.target._tag === "RelayConnectionTarget"
          ? Ref.set(relayAttempted, true).pipe(Effect.as(leaseFor(route)))
          : Effect.never,
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust("7 seconds");
    expect(yield* Ref.get(relayAttempted)).toBe(false);

    yield* TestClock.adjust("1 second");
    const lease = yield* Fiber.join(connecting);
    expect(lease.prepared.target._tag).toBe("RelayConnectionTarget");
  }),
);

it.effect("gives a LAN route with no other route to fall back to its full time", () =>
  Effect.gen(function* () {
    const connecting = yield* Effect.scoped(
      ConnectionDriver.connectOverRoutes(LAN_ONLY, answered, (route) =>
        Effect.sleep("20 seconds").pipe(Effect.as(leaseFor(route))),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust("20 seconds");
    const lease = yield* Fiber.join(connecting);
    expect(lease.prepared.target._tag).toBe("BearerConnectionTarget");
  }),
);

it.effect("keeps the LAN route first when it connects promptly", () =>
  Effect.gen(function* () {
    const relayAttempted = yield* Ref.make(false);
    const lease = yield* Effect.scoped(
      ConnectionDriver.connectOverRoutes(LAN_THEN_RELAY, answered, (route) =>
        route.target._tag === "RelayConnectionTarget"
          ? Ref.set(relayAttempted, true).pipe(Effect.as(leaseFor(route)))
          : Effect.succeed(leaseFor(route)),
      ),
    );

    expect(lease.prepared.target._tag).toBe("BearerConnectionTarget");
    expect(yield* Ref.get(relayAttempted)).toBe(false);
  }),
);

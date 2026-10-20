import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionTransientError } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  connectionRouteKind,
  connectionRoutes,
  routeEntry,
  routeHttpBaseUrl,
  sendsTokenInClear,
  usableRoutes,
} from "./routes.ts";
import * as RpcSession from "../rpc/session.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export type RouteCheck = "answered" | "silent" | "unchecked";

const ROUTE_CHECK_TIMEOUT_MS = 2_500;
const LAN_ROUTE_CHECK_TIMEOUT_MS = 1_000;
const LAN_ROUTE_ATTEMPT_TIMEOUT_MS = 8_000;

const routeCheckTimeoutMs = (route: ConnectionRoute) =>
  connectionRouteKind(route) === "lan" ? LAN_ROUTE_CHECK_TIMEOUT_MS : ROUTE_CHECK_TIMEOUT_MS;

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    readonly checkRoute: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<RouteCheck>;
    readonly preflight: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/client-runtime/connection/driver/ConnectionDriver") {}

export const connectOverRoutes = Effect.fn("ConnectionDriver.connectOverRoutes")(function* <R>(
  entry: ConnectionCatalogEntry,
  checkRoute: (route: ConnectionRoute) => Effect.Effect<RouteCheck>,
  connectRoute: (
    route: ConnectionRoute,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, R | Scope.Scope>,
) {
  const routes = usableRoutes(entry);
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)));
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  // Each route gets its own scope so a half-open session closes before the next try.
  const attempt = Effect.fnUntraced(function* (route: ConnectionRoute, final: boolean) {
    const routeScope = yield* Scope.fork(attemptScope);
    const result = yield* connectRoute(route).pipe(
      final || connectionRouteKind(route) !== "lan"
        ? identity
        : Effect.timeoutOrElse({
            duration: LAN_ROUTE_ATTEMPT_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new ConnectionTransientError({
                  reason: "timeout",
                  detail: `${entry.target.label} did not finish connecting over the local network.`,
                }),
              ),
          }),
      Scope.provide(routeScope),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit))),
      Effect.result,
    );
    if (result._tag === "Failure") {
      if (result.failure._tag === "ConnectionTransientError") transient ??= result.failure;
      else blocked ??= result.failure;
    }
    return result;
  });
  const silent: Array<ConnectionRoute> = [];
  for (const [index, route] of routes.entries()) {
    const check = checks.length === 0 ? "unchecked" : yield* Fiber.join(checks[index]!);
    if (check === "silent") {
      silent.push(route);
      continue;
    }
    const result = yield* attempt(route, index === routes.length - 1 && silent.length === 0);
    if (result._tag === "Success") return result.success;
    // An incompatible server is the same server on every route.
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  for (const [index, route] of silent.entries()) {
    const result = yield* attempt(route, index === silent.length - 1);
    if (result._tag === "Success") return result.success;
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  return yield* (
    transient ??
      blocked ??
      new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: `${entry.target.label} did not answer on any saved route.`,
      })
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;

  // Resolves to the route's descriptor, null when it is silent, or undefined
  // when it has no address to check.
  const describeRoute = (
    entry: ConnectionCatalogEntry,
    route: ConnectionRoute,
  ): Effect.Effect<ExecutionEnvironmentDescriptor | null | undefined> => {
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) return Effect.succeed(undefined);
    // The descriptor is public, so this sends no credential to whatever
    // answers at a saved LAN address on a different network.
    return fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: routeCheckTimeoutMs(route),
    }).pipe(
      Effect.map((descriptor) =>
        descriptor.environmentId === entry.target.environmentId ? descriptor : null,
      ),
      Effect.orElseSucceed(() => null),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };
  const routeCheck = (descriptor: ExecutionEnvironmentDescriptor | null | undefined): RouteCheck =>
    descriptor === undefined ? "unchecked" : descriptor === null ? "silent" : "answered";

  const checkRoute = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    describeRoute(entry, route).pipe(Effect.map(routeCheck));

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
      "connection.route.count": connectionRoutes(entry).length,
    });
    yield* reportProgress({ stage: "preparing" });
    const checked = new Map<ConnectionRoute, ExecutionEnvironmentDescriptor>();
    return yield* connectOverRoutes(
      entry,
      (route) =>
        describeRoute(entry, route).pipe(
          Effect.tap((descriptor) =>
            Effect.sync(() => descriptor && checked.set(route, descriptor)),
          ),
          Effect.map(routeCheck),
        ),
      Effect.fnUntraced(function* (route) {
        const prepared = yield* resolver.prepare(routeEntry(entry, route), checked.get(route));
        yield* reportProgress({ stage: "opening", prepared });
        const session = yield* sessions.connect(prepared);
        yield* reportProgress({ stage: "synchronizing", prepared });
        yield* session.ready;
        return { prepared, session } satisfies EnvironmentConnectionLease;
      }),
    );
  });

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    (sendsTokenInClear(connectionRoutes(entry), route)
      ? Effect.succeed(null)
      : describeRoute(entry, route)
    ).pipe(
      Effect.flatMap((descriptor) =>
        descriptor
          ? resolver.prepare(routeEntry(entry, route), descriptor).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
      Effect.withSpan("ConnectionDriver.preflight"),
    );

  return ConnectionDriver.of({ connect, checkRoute, preflight });
});

export const layer = Layer.effect(ConnectionDriver, make);

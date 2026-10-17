import { TextGenerationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  defaultProviderContinuationIdentity,
  type ProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "./driver.ts";
import { ProviderDriverError } from "./errors.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./maintenanceResolver.ts";
import {
  ProviderAdapterCapabilitiesError,
  ProviderAdapterOpenSessionError,
} from "./ProviderAdapter.ts";
import { buildServerProvider } from "./snapshotProbe.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";

export interface LazyProviderDriverManifest<Config, R, UsageR> extends Omit<
  ProviderDriver<Config, R, UsageR>,
  "create"
> {
  readonly load: () => Promise<ProviderDriver<Config, R, UsageR>>;
  /** Must match what the real driver reports, or threads lose their continuation group. */
  readonly continuationIdentity?: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderContinuationIdentity, never, R>;
}

/**
 * Keeps a driver's module out of memory until an instance of it is enabled or
 * actually used. A disabled instance gets a static snapshot, and its adapter
 * and text generation build the real instance on first call.
 */
export const lazyProviderDriver = <Config, R, UsageR>(
  manifest: LazyProviderDriverManifest<Config, R, UsageR>,
): ProviderDriver<Config, R, UsageR> => {
  const { load, continuationIdentity, ...driver } = manifest;
  const loadDriver = (input: ProviderDriverCreateInput<Config>) =>
    Effect.tryPromise({
      try: load,
      catch: (cause) =>
        new ProviderDriverError({
          driver: driver.driverKind,
          instanceId: input.instanceId,
          detail: "Failed to load provider driver.",
          cause,
        }),
    });

  const createDisabled = (input: ProviderDriverCreateInput<Config>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R | Scope.Scope>();
      const real = yield* Effect.cached(
        loadDriver(input).pipe(
          Effect.flatMap((loaded) => loaded.create(input)),
          Effect.provideContext(context),
        ),
      );
      const continuation = continuationIdentity
        ? yield* continuationIdentity(input)
        : defaultProviderContinuationIdentity({
            driverKind: driver.driverKind,
            instanceId: input.instanceId,
          });
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const snapshot = withInstanceIdentity({
        instanceId: input.instanceId,
        driverKind: driver.driverKind,
        displayName: input.displayName,
        accentColor: input.accentColor,
        continuationGroupKey: continuation.continuationKey,
      })(
        buildServerProvider({
          presentation: { displayName: driver.metadata.displayName },
          enabled: false,
          checkedAt,
          models: [],
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: `${driver.metadata.displayName} is disabled in T3 Code settings.`,
          },
        }),
      );

      const capabilitiesError = (cause: ProviderDriverError) =>
        new ProviderAdapterCapabilitiesError({ driver: driver.driverKind, cause });
      const generation = (operation: keyof ProviderTextGeneration) =>
        real.pipe(
          Effect.mapError(
            (cause) => new TextGenerationError({ operation, detail: cause.detail, cause }),
          ),
          Effect.map((instance) => instance.textGeneration),
        );

      return {
        instanceId: input.instanceId,
        driverKind: driver.driverKind,
        continuationIdentity: continuation,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: false,
        snapshot: {
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: driver.driverKind,
                packageName: null,
              }),
            ),
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
        },
        orchestrationAdapter: {
          instanceId: input.instanceId,
          driver: driver.driverKind,
          getCapabilities: () =>
            real.pipe(
              Effect.mapError(capabilitiesError),
              Effect.flatMap((instance) => instance.orchestrationAdapter.getCapabilities()),
            ),
          planSelectionTransition: (transition) =>
            real.pipe(
              Effect.mapError(capabilitiesError),
              Effect.flatMap((instance) =>
                instance.orchestrationAdapter.planSelectionTransition(transition),
              ),
            ),
          openSession: (session) =>
            real.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterOpenSessionError({
                    driver: driver.driverKind,
                    providerSessionId: session.providerSessionId,
                    cause,
                  }),
              ),
              Effect.flatMap((instance) => instance.orchestrationAdapter.openSession(session)),
            ),
        },
        textGeneration: {
          generateCommitMessage: (request) =>
            generation("generateCommitMessage").pipe(
              Effect.flatMap((text) => text.generateCommitMessage(request)),
            ),
          generatePrContent: (request) =>
            generation("generatePrContent").pipe(
              Effect.flatMap((text) => text.generatePrContent(request)),
            ),
          generateBranchName: (request) =>
            generation("generateBranchName").pipe(
              Effect.flatMap((text) => text.generateBranchName(request)),
            ),
          generateThreadTitle: (request) =>
            generation("generateThreadTitle").pipe(
              Effect.flatMap((text) => text.generateThreadTitle(request)),
            ),
          generateReviewGuide: (request) =>
            generation("generateReviewGuide").pipe(
              Effect.flatMap((text) => text.generateReviewGuide(request)),
            ),
        },
      } satisfies ProviderInstance;
    });

  return {
    ...driver,
    create: (input) =>
      input.enabled
        ? loadDriver(input).pipe(Effect.flatMap((loaded) => loaded.create(input)))
        : createDisabled(input),
  };
};

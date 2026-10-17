import type {
  CodexSettings,
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";

export interface CodexAppServerClientFactoryShape {
  readonly open: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly settings: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    ProviderAdapter.ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
}

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("t3/orchestration-v2/Adapters/CodexAppServerClientFactory") {}

/** Defers loading the Codex adapter and its protocol schemas until a session opens. */
export const layerLazy: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  ChildProcessSpawner.ChildProcessSpawner | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | ChildProcessSpawner.ChildProcessSpawner
      | ProviderEventLoggers.ProviderEventLoggers
      | Scope.Scope
    >();
    const factory = yield* Effect.cached(
      Effect.promise(() => import("./CodexAdapterV2.ts")).pipe(
        Effect.flatMap((adapter) => Layer.build(adapter.layerAppServerClientFactory)),
        Effect.map((built) => Context.get(built, CodexAppServerClientFactory)),
        Effect.provideContext(context),
      ),
    );
    return CodexAppServerClientFactory.of({
      open: (input) => factory.pipe(Effect.flatMap((loaded) => loaded.open(input))),
    });
  }),
);

import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderDriver, ProviderDriverCreateInput, ProviderInstance } from "./driver.ts";
import { lazyProviderDriver } from "./lazyDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok");
const TestSettings = Schema.Struct({ enabled: Schema.Boolean });
type TestSettings = typeof TestSettings.Type;
const capabilities = { marker: "real" } as unknown as OrchestrationV2ProviderCapabilities;

const makeHarness = () => {
  const counts = { loads: 0, creates: 0 };
  const realDriver: ProviderDriver<TestSettings> = {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Grok" },
    configSchema: TestSettings,
    defaultConfig: () => ({ enabled: true }),
    create: (input) =>
      Effect.sync(() => {
        counts.creates += 1;
        return {
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          enabled: input.enabled,
          orchestrationAdapter: { getCapabilities: () => Effect.succeed(capabilities) },
        } as unknown as ProviderInstance;
      }),
  };
  const driver = lazyProviderDriver({
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Grok" },
    configSchema: TestSettings,
    defaultConfig: () => ({ enabled: true }),
    load: () => {
      counts.loads += 1;
      return Promise.resolve(realDriver);
    },
  });
  return { driver, counts };
};

const createInput = (enabled: boolean): ProviderDriverCreateInput<TestSettings> => ({
  instanceId: ProviderInstanceId.make("grok"),
  displayName: undefined,
  environment: [],
  enabled,
  config: { enabled },
});

describe("lazyProviderDriver", () => {
  it.effect("loads the driver to create an enabled instance", () =>
    Effect.gen(function* () {
      const { driver, counts } = makeHarness();
      const instance = yield* driver.create(createInput(true));
      assert.isTrue(instance.enabled);
      assert.deepStrictEqual(counts, { loads: 1, creates: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("serves a disabled instance without loading until its adapter is used", () =>
    Effect.gen(function* () {
      const { driver, counts } = makeHarness();
      const instance = yield* driver.create(createInput(false));
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.isFalse(snapshot.enabled);
      assert.strictEqual(snapshot.status, "disabled");
      assert.strictEqual(snapshot.message, "Grok is disabled in T3 Code settings.");
      assert.deepStrictEqual(counts, { loads: 0, creates: 0 });

      assert.strictEqual(yield* instance.orchestrationAdapter.getCapabilities(), capabilities);
      assert.strictEqual(yield* instance.orchestrationAdapter.getCapabilities(), capabilities);
      assert.deepStrictEqual(counts, { loads: 1, creates: 1 });
    }).pipe(Effect.scoped),
  );
});

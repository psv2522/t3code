import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
import { DEFAULT_LOCALE } from "../i18n/locales";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import {
  adoptMobileSettingsEntries,
  mobileSyncedSettingValues,
} from "../state/settings-sync.logic";
import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));

function preferencesLayer(initial: unknown = {}) {
  let stored = { payload: JSON.stringify(initial), updatedAt: 1 };
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => Effect.succeedNone,
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => Option.some(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  return MobilePreferences.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(MobileDatabase.MobileDatabase, database),
        Layer.succeed(MobileSecureStorage.MobileSecureStorage, {
          getItem: () => Effect.succeed(null),
          setItem: () => Effect.void,
          removeItem: () => Effect.void,
        }),
      ),
    ),
  );
}

describe("mobile preferences sync", () => {
  it.effect(
    "stamps canonical changes through storage and preserves adopted timestamps and newer local edits",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(100);
        const store = yield* MobilePreferences.MobilePreferencesStore;
        const saved = yield* store.savePatch({
          language: "fr",
          workingShelfEnabled: false,
          projectGroupingEnabled: false,
        });
        expect(saved.settingsSyncTimestamps).toEqual({
          language: 100,
          sidebarWorkingShelfEnabled: 100,
          sidebarProjectGroupingMode: 100,
        });
        expect(mobileSyncedSettingValues(saved)).toEqual({
          toolCallVisibility: "showAll",
          showHighestReasoningEfforts: true,
          followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
          language: "fr",
          mathRenderingEnabled: false,
          sidebarWorkingShelfEnabled: false,
          sidebarProjectGroupingMode: "separate",
        });
        yield* TestClock.setTime(200);
        const adopted = yield* store.update((current) =>
          adoptMobileSettingsEntries(current, {
            sidebarProjectGroupingMode: { value: "repository_path", updatedAt: 150 },
            language: { value: "de", updatedAt: 150 },
            toolCallVisibility: { value: "hideAll", updatedAt: 150 },
            showHighestReasoningEfforts: { value: false, updatedAt: 150 },
            followUpBehavior: { value: "queue", updatedAt: 150 },
            mathRenderingEnabled: { value: true, updatedAt: 150 },
            sidebarWorkingShelfEnabled: { value: true, updatedAt: 150 },
          }),
        );
        expect(adopted.projectGroupingEnabled).toBe(true);
        expect(mobileSyncedSettingValues(adopted)).toEqual({
          toolCallVisibility: "hideAll",
          showHighestReasoningEfforts: false,
          followUpBehavior: "queue",
          language: "de",
          mathRenderingEnabled: true,
          sidebarWorkingShelfEnabled: true,
          sidebarProjectGroupingMode: "repository_path",
        });
        expect(Object.values(adopted.settingsSyncTimestamps!)).toEqual(Array(7).fill(150));
        yield* store.savePatch({ language: "en" });
        yield* store.update((current) =>
          adoptMobileSettingsEntries(current, { language: { value: "fr", updatedAt: 175 } }),
        );
        const latest = yield* store.load;
        expect(latest.language).toBe("en");
        expect(latest.settingsSyncTimestamps?.language).toBe(200);
        const unchanged = yield* store.savePatch({ baseFontSize: 18 });
        expect(unchanged.settingsSyncTimestamps).toEqual(latest.settingsSyncTimestamps);
      }).pipe(Effect.provide(preferencesLayer())),
  );

  it.effect(
    "sanitizes sync metadata while retaining good timestamps and unrelated preferences",
    () =>
      Effect.gen(function* () {
        const store = yield* MobilePreferences.MobilePreferencesStore;
        const loaded = yield* store.load;
        expect(loaded).toEqual({
          settingsSyncEnabled: true,
          settingsSyncTimestamps: { language: 10, future: 0 },
          baseFontSize: 20,
        });
        expect(mobileSyncedSettingValues({}).language).toBe(DEFAULT_LOCALE);
      }).pipe(
        Effect.provide(
          preferencesLayer({
            settingsSyncEnabled: true,
            settingsSyncTimestamps: { language: 10, future: 0, bad: -1, text: "3", empty: null },
            baseFontSize: 20,
          }),
        ),
      ),
  );

  it.effect("drops malformed sync fields", () =>
    Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      expect(yield* store.load).toEqual({});
    }).pipe(
      Effect.provide(preferencesLayer({ settingsSyncEnabled: "true", settingsSyncTimestamps: [] })),
    ),
  );
});

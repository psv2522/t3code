import { DEFAULT_CLIENT_SETTINGS, type SyncedClientSettings } from "@t3tools/contracts/settings";
import { mergeSyncedClientSettings } from "@t3tools/shared/syncedClientSettings";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  adoptClientSettingsEntries,
  planClientSettingsSync,
  pushClientSettingsWithRetry,
  stampClientSettingsChanges,
} from "./clientSettingsSync.ts";

const environment = (
  settings: SyncedClientSettings | undefined,
  writable = true,
  environmentId = "a",
  inFlight?: SyncedClientSettings,
) => ({ environmentId, settings, writable, inFlight });
const plan = (input: Partial<Parameters<typeof planClientSettingsSync>[0]>) =>
  planClientSettingsSync({
    values: DEFAULT_CLIENT_SETTINGS,
    timestamps: {},
    defaults: DEFAULT_CLIENT_SETTINGS,
    now: 100,
    environments: [],
    ...input,
  });

describe("client settings replication", () => {
  it("adopts a newer remote entry and pushes a newer local entry", () => {
    const remote = {
      language: { value: "fr", updatedAt: 20 },
      mathRenderingEnabled: { value: false, updatedAt: 1 },
    };
    const result = plan({
      values: { ...DEFAULT_CLIENT_SETTINGS, mathRenderingEnabled: true },
      timestamps: { language: 10, mathRenderingEnabled: 30 },
      environments: [environment(remote)],
    });
    expect(result.adopts).toEqual({ language: remote.language });
    expect(result.pushes).toEqual([
      {
        environmentId: "a",
        syncedClientSettings: { mathRenderingEnabled: { value: true, updatedAt: 30 } },
      },
    ]);

    const adopted = { ...DEFAULT_CLIENT_SETTINGS, language: "fr" };
    const edited = { ...adopted, language: "de" };
    for (const now of [19, 20]) {
      const timestamps = stampClientSettingsChanges(adopted, edited, { language: 20 }, now);
      expect(timestamps.language).toBe(21);
      const next = plan({ values: edited, timestamps, now, environments: [environment(remote)] });
      expect(next.adopts.language).toBeUndefined();
      expect(next.pushes[0]?.syncedClientSettings.language).toEqual({
        value: "de",
        updatedAt: 21,
      });
      expect(stampClientSettingsChanges(edited, adopted, timestamps, now).language).toBe(22);
    }
  });

  it("seeds only customisations absent from every supporting environment", () => {
    const values = { ...DEFAULT_CLIENT_SETTINGS, language: "fr", mathRenderingEnabled: true };
    expect(plan({ values }).seeds).toEqual({});
    expect(plan({ values, environments: [environment(undefined)] }).seeds).toEqual({});
    const result = plan({
      values,
      environments: [
        environment({}),
        environment({ language: { value: "de", updatedAt: 1 } }, true, "b"),
      ],
    });
    expect(result.seeds).toEqual({ mathRenderingEnabled: { value: true, updatedAt: 100 } });
    expect(result.adopts).toEqual({ language: { value: "de", updatedAt: 1 } });
    expect(Object.keys(result.pushes[0]!.syncedClientSettings).sort()).toEqual([
      "language",
      "mathRenderingEnabled",
    ]);
  });

  it("ignores unknown and undecodable entries and compares pushes against raw values", () => {
    const settings = {
      language: { value: { futureLocale: "fr" }, updatedAt: 30 },
      future: { value: false, updatedAt: 40 },
    };
    expect(
      plan({
        values: { ...DEFAULT_CLIENT_SETTINGS, language: "fr" },
        environments: [environment(settings)],
      }),
    ).toEqual({ adopts: {}, seeds: {}, pushes: [] });
    expect(
      plan({ timestamps: { language: 20 }, environments: [environment(settings)] }).pushes,
    ).toEqual([]);
    expect(
      plan({ timestamps: { language: 30 }, environments: [environment(settings)] }).pushes,
    ).toEqual([]);
    const newer = plan({ timestamps: { language: 50 }, environments: [environment(settings)] });
    expect(newer.pushes).toEqual([
      {
        environmentId: "a",
        syncedClientSettings: {
          language: { value: DEFAULT_CLIENT_SETTINGS.language, updatedAt: 50 },
        },
      },
    ]);
  });

  it("adopts from read-only environments and never pushes to read-only or unsupported ones", () => {
    const remote = { language: { value: "fr", updatedAt: 20 } };
    const result = plan({
      timestamps: { mathRenderingEnabled: 5 },
      environments: [environment(remote, false), environment(undefined, true, "old")],
    });
    expect(result.adopts).toEqual(remote);
    expect(result.pushes).toEqual([]);
  });

  it("converges across two environments in either order and reaches a fixpoint", () => {
    const a = { language: { value: "fr", updatedAt: 10 } };
    const b = {
      language: { value: "de", updatedAt: 10 },
      mathRenderingEnabled: { value: true, updatedAt: 20 },
    };
    const targets = [environment(a), environment(b, true, "b")];
    const first = plan({ environments: targets });
    expect(plan({ environments: [...targets].reverse() }).adopts).toEqual(first.adopts);
    const adopted = adoptClientSettingsEntries(
      DEFAULT_CLIENT_SETTINGS,
      {},
      { ...first.adopts, ...first.seeds },
    );
    const second = plan({
      values: { ...DEFAULT_CLIENT_SETTINGS, ...adopted.values },
      timestamps: adopted.timestamps,
      environments: targets.map((target) =>
        environment(
          mergeSyncedClientSettings(
            target.settings!,
            first.pushes.find((push) => push.environmentId === target.environmentId)
              ?.syncedClientSettings ?? {},
          ),
          true,
          target.environmentId,
        ),
      ),
    });
    expect(second).toEqual({ adopts: {}, seeds: {}, pushes: [] });
    expect(first.adopts.language?.value).toBe("fr");
  });

  it("does not resend entries in flight, but sends newer edits and retries after reset", () => {
    const timestamps = { language: 10 };
    const initial = plan({ timestamps, environments: [environment({})] });
    const inFlight = initial.pushes[0]!.syncedClientSettings;
    expect(
      plan({ timestamps, environments: [environment({}, true, "a", inFlight)] }).pushes,
    ).toEqual([]);
    expect(
      plan({ timestamps: { language: 20 }, environments: [environment({}, true, "a", inFlight)] })
        .pushes,
    ).toHaveLength(1);
    expect(plan({ timestamps, environments: [environment({})] }).pushes).toEqual(initial.pushes);
  });

  it("retries failed pushes with capped exponential backoff until they succeed", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const push = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
      const result = pushClientSettingsWithRetry(push, controller.signal);
      expect(push).toHaveBeenCalledTimes(1);
      let calls = 1;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(push).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(1);
        expect(push).toHaveBeenCalledTimes(++calls);
      }
      push.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });

  it("cancels pending retries and skips pushes after the connection or sync stops", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const push = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
      const result = pushClientSettingsWithRetry(push, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await expect(result).resolves.toBe(false);
      await vi.runAllTimersAsync();
      expect(push).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(pushClientSettingsWithRetry(push, controller.signal)).resolves.toBe(false);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });
});

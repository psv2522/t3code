import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";

it.effect("leaves the stock updater unloaded until an update operation needs it", () =>
  Effect.gen(function* () {
    vi.resetModules();
    let loaded = false;
    const updater = { autoDownload: true, channel: "latest" };
    vi.doMock("electron-updater", () => {
      loaded = true;
      return { default: { autoUpdater: updater } };
    });
    try {
      const { make } = yield* Effect.promise(() => import("./ElectronUpdater.ts"));
      expect(loaded).toBe(false);
      yield* make.setAutoDownload(false);
      expect(loaded).toBe(true);
      expect(updater.autoDownload).toBe(false);
      yield* make.setChannel("nightly");
      expect(updater.channel).toBe("nightly");
    } finally {
      vi.doUnmock("electron-updater");
      vi.resetModules();
    }
  }),
);

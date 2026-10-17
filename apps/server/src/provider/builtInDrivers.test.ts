import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("lazy built-in driver manifests", () => {
  it("match the real drivers", async () => {
    const drivers = await Promise.all([
      import("./Drivers/CodexDriver.ts").then((m) => m.CodexDriver),
      import("@t3tools/provider-cursor/server").then((m) => m.CursorDriver),
      import("@t3tools/provider-grok/server").then((m) => m.GrokDriver),
      import("@t3tools/provider-fx/server").then((m) => m.FxDriver),
      import("@t3tools/provider-opencode/server").then((m) => m.OpenCodeDriver),
      import("./Drivers/AntigravityDriver.ts").then((m) => m.AntigravityDriver),
      import("@t3tools/provider-kiro/server").then((m) => m.KiroDriver),
      import("@t3tools/provider-pi/server").then((m) => m.PiDriver),
      import("@t3tools/provider-muse/server").then((m) => m.MuseDriver),
      import("@t3tools/provider-acp-registry/server").then((m) => m.AcpRegistryDriver),
    ]);
    expect(drivers).toHaveLength(BUILT_IN_DRIVERS.length - 1);
    for (const real of drivers) {
      const manifest = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === real.driverKind);
      expect(manifest, real.driverKind).toBeDefined();
      expect(manifest?.metadata, real.driverKind).toEqual(real.metadata);
      expect(manifest?.configSchema, real.driverKind).toBe(real.configSchema);
    }
  });
});

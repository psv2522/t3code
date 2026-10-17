import { AntigravitySettings, CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import type { AcpRegistryDriverEnv } from "@t3tools/provider-acp-registry/server";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { CursorDriverEnv } from "@t3tools/provider-cursor/server";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import type { GrokDriverEnv } from "@t3tools/provider-grok/server";
import { grokUsageReader } from "@t3tools/provider-grok/server/usage";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import type { MuseDriverEnv } from "@t3tools/provider-muse/server";
import { MuseSettings } from "@t3tools/provider-muse/settings";
import type { OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import { openCodeUsageReader } from "@t3tools/provider-opencode/server/usage";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import type { PiDriverEnv } from "@t3tools/provider-pi/server";
import { piUsageReader } from "@t3tools/provider-pi/server/usage";
import { PiSettings } from "@t3tools/provider-pi/settings";
import type {
  AnyProviderDriver,
  ProviderUsageReaderEnv,
} from "@t3tools/provider-core/server/driver";
import { lazyProviderDriver } from "@t3tools/provider-core/server/lazyDriver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AntigravityUsage from "./Drivers/AntigravityUsage.ts";
import type { AntigravityDriverEnv } from "./Drivers/AntigravityDriver.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { codexUsageReader } from "./Drivers/codexUsage.ts";
import type { CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { codexContinuationIdentity, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeMuseSettings = Schema.decodeSync(MuseSettings);
const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

const CodexDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("codex"),
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  configSchema: CodexSettings,
  defaultConfig: () => decodeCodexSettings({}),
  usage: codexUsageReader,
  continuationIdentity: ({ config }) =>
    resolveCodexHomeLayout(config).pipe(Effect.map(codexContinuationIdentity)),
  load: () => import("./Drivers/CodexDriver.ts").then((m) => m.CodexDriver),
});

const CursorDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("cursor"),
  metadata: { displayName: "Cursor", supportsMultipleInstances: true },
  configSchema: CursorSettings,
  defaultConfig: () => decodeCursorSettings({}),
  usage: {
    kind: "scan",
    provider: "cursor",
    scan: ({ settings, windowStartMs, retentionCutoffMs, awaitRefresh }) =>
      CursorUsageAccounts.CursorUsageAccounts.pipe(
        Effect.flatMap((accounts) =>
          accounts.scan({
            keychainUsageEnabled: settings.cursorKeychainUsageEnabled,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          }),
        ),
      ),
  },
  load: () => import("@t3tools/provider-cursor/server").then((m) => m.CursorDriver),
});

const GrokDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("grok"),
  metadata: { displayName: "Grok", supportsMultipleInstances: true },
  configSchema: GrokSettings,
  defaultConfig: () => decodeGrokSettings({}),
  usage: grokUsageReader,
  load: () => import("@t3tools/provider-grok/server").then((m) => m.GrokDriver),
});

const OpenCodeDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("opencode"),
  metadata: { displayName: "OpenCode", supportsMultipleInstances: true },
  configSchema: OpenCodeSettings,
  defaultConfig: () => decodeOpenCodeSettings({}),
  usage: openCodeUsageReader,
  load: () => import("@t3tools/provider-opencode/server").then((m) => m.OpenCodeDriver),
});

const AntigravityDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("antigravity"),
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeAntigravitySettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  load: () => import("./Drivers/AntigravityDriver.ts").then((m) => m.AntigravityDriver),
});

const PiDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("pi"),
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
  usage: piUsageReader,
  load: () => import("@t3tools/provider-pi/server").then((m) => m.PiDriver),
});

const MuseDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("muse"),
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => decodeMuseSettings({}),
  load: () => import("@t3tools/provider-muse/server").then((m) => m.MuseDriver),
});

const AcpRegistryDriver = lazyProviderDriver({
  driverKind: ProviderDriverKind.make("acpRegistry"),
  metadata: {
    displayName: "ACP Registry",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeAcpRegistrySettings({}),
  load: () => import("@t3tools/provider-acp-registry/server").then((m) => m.AcpRegistryDriver),
});

export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | AntigravityDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | GrokDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv
  | MuseDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  GrokDriver,
  OpenCodeDriver,
  AntigravityDriver,
  PiDriver,
  MuseDriver,
  AcpRegistryDriver,
];

export type BuiltInUsageReadersEnv =
  | ProviderUsageReaderEnv<typeof ClaudeDriver>
  | ProviderUsageReaderEnv<typeof CodexDriver>
  | ProviderUsageReaderEnv<typeof GrokDriver>
  | ProviderUsageReaderEnv<typeof OpenCodeDriver>
  | ProviderUsageReaderEnv<typeof AntigravityDriver>
  | ProviderUsageReaderEnv<typeof CursorDriver>
  | ProviderUsageReaderEnv<typeof PiDriver>
  | ProviderUsageReaderEnv<typeof MuseDriver>;

/**
 * Aggregation keeps the first copy of a duplicate record, so the order is part
 * of the result.
 */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [
  ClaudeDriver,
  CodexDriver,
  GrokDriver,
  PiDriver,
  OpenCodeDriver,
  MuseDriver,
  AntigravityDriver,
  CursorDriver,
];

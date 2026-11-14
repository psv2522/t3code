// @effect-diagnostics globalTimers:off - Settings sync retries run outside an Effect runtime.
import {
  ClientSettingsSchema,
  type ClientSettings,
  type SyncedClientSettings,
  type SyncedClientSettingEntry,
} from "@t3tools/contracts/settings";
import {
  compareSyncedClientSettingEntries,
  mergeSyncedClientSettings,
} from "@t3tools/shared/syncedClientSettings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const SYNCED_CLIENT_SETTING_KEYS = [
  "toolCallVisibility",
  "showHighestReasoningEfforts",
  "followUpBehavior",
  "language",
  "mathRenderingEnabled",
  "sidebarWorkingShelfEnabled",
  "sidebarProjectGroupingMode",
] as const satisfies ReadonlyArray<keyof ClientSettings>;

export type SyncedClientSettingKey = (typeof SYNCED_CLIENT_SETTING_KEYS)[number];
export type SyncedClientSettingValues = Pick<ClientSettings, SyncedClientSettingKey>;

const settingCodecs = Object.fromEntries(
  SYNCED_CLIENT_SETTING_KEYS.map((key) => [
    key,
    {
      decode: Schema.decodeUnknownOption(ClientSettingsSchema.fields[key]),
      equals: Schema.toEquivalence<SyncedClientSettingValues[SyncedClientSettingKey]>(
        ClientSettingsSchema.fields[key],
      ),
    },
  ]),
);

function validEntries(entries: SyncedClientSettings): SyncedClientSettings {
  return Object.fromEntries(
    SYNCED_CLIENT_SETTING_KEYS.flatMap((key) => {
      if (!Object.hasOwn(entries, key)) return [];
      const entry = entries[key]!;
      const decoded = settingCodecs[key]!.decode(entry.value);
      return Option.isSome(decoded) ? [[key, { ...entry, value: decoded.value }]] : [];
    }),
  );
}

export function stampClientSettingsChanges(
  previous: SyncedClientSettingValues,
  next: SyncedClientSettingValues,
  timestamps: Readonly<Record<string, number>>,
  now: number,
): Readonly<Record<string, number>> {
  let result = timestamps;
  for (const key of SYNCED_CLIENT_SETTING_KEYS) {
    if (settingCodecs[key]!.equals(previous[key], next[key])) continue;
    if (result === timestamps) result = { ...timestamps };
    (result as Record<string, number>)[key] = Math.max(now, (timestamps[key] ?? -1) + 1);
  }
  return result;
}

export async function pushClientSettingsWithRetry(
  push: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  for (let delay = 1_000; !signal.aborted; delay = Math.min(delay * 2, 30_000)) {
    if (await push()) return true;
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  return false;
}

export function adoptClientSettingsEntries(
  values: SyncedClientSettingValues,
  timestamps: Readonly<Record<string, number>>,
  entries: SyncedClientSettings,
) {
  const adopted: Partial<SyncedClientSettingValues> = {};
  const nextTimestamps = { ...timestamps };
  for (const key of SYNCED_CLIENT_SETTING_KEYS) {
    const entry = entries[key];
    if (!entry) continue;
    const updatedAt = timestamps[key];
    if (
      updatedAt !== undefined &&
      compareSyncedClientSettingEntries(entry, { value: values[key], updatedAt }) <= 0
    )
      continue;
    Object.assign(adopted, { [key]: entry.value });
    nextTimestamps[key] = entry.updatedAt;
  }
  return { values: adopted, timestamps: nextTimestamps };
}

export function planClientSettingsSync<Id extends string>(input: {
  readonly values: SyncedClientSettingValues;
  readonly timestamps: Readonly<Record<string, number>>;
  readonly defaults: SyncedClientSettingValues;
  readonly now: number;
  readonly environments: ReadonlyArray<{
    readonly environmentId: Id;
    readonly settings: SyncedClientSettings | undefined;
    readonly writable: boolean;
    readonly inFlight?: SyncedClientSettings | undefined;
  }>;
}) {
  const environments = input.environments.filter(
    (environment) => environment.settings !== undefined,
  );
  let merged: SyncedClientSettings = Object.fromEntries(
    SYNCED_CLIENT_SETTING_KEYS.flatMap((key) => {
      const updatedAt = input.timestamps[key];
      return updatedAt === undefined ? [] : [[key, { value: input.values[key], updatedAt }]];
    }),
  );
  for (const environment of environments) {
    merged = mergeSyncedClientSettings(merged, validEntries(environment.settings!));
  }
  const seeds: Record<string, SyncedClientSettingEntry> = {};
  if (environments.length > 0) {
    for (const key of SYNCED_CLIENT_SETTING_KEYS) {
      if (
        input.timestamps[key] !== undefined ||
        environments.some((environment) => Object.hasOwn(environment.settings!, key))
      )
        continue;
      if (settingCodecs[key]!.equals(input.values[key], input.defaults[key])) continue;
      seeds[key] = { value: input.values[key], updatedAt: input.now };
    }
  }
  merged = mergeSyncedClientSettings(merged, seeds);
  const adopts: Record<string, SyncedClientSettingEntry> = {};
  for (const key of SYNCED_CLIENT_SETTING_KEYS) {
    const entry = merged[key];
    if (!entry || seeds[key]) continue;
    const updatedAt = input.timestamps[key];
    if (
      updatedAt === undefined ||
      compareSyncedClientSettingEntries(entry, { value: input.values[key], updatedAt }) > 0
    )
      adopts[key] = entry;
  }
  const pushes = environments.flatMap((environment) => {
    if (!environment.writable) return [];
    const entries = Object.fromEntries(
      Object.entries(merged).filter(([key, entry]) => {
        const raw = Object.hasOwn(environment.settings!, key)
          ? environment.settings![key]
          : undefined;
        const pending = environment.inFlight?.[key];
        return (
          (!raw || compareSyncedClientSettingEntries(entry, raw) > 0) &&
          (!pending || compareSyncedClientSettingEntries(entry, pending) > 0)
        );
      }),
    );
    return Object.keys(entries).length === 0
      ? []
      : [{ environmentId: environment.environmentId, syncedClientSettings: entries }];
  });
  return { adopts, seeds, pushes };
}

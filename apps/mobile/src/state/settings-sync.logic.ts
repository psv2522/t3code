import {
  adoptClientSettingsEntries,
  stampClientSettingsChanges,
  SYNCED_CLIENT_SETTING_KEYS,
  type SyncedClientSettingValues,
} from "@t3tools/client-runtime/state/client-settings-sync";
import type { SyncedClientSettings } from "@t3tools/contracts/settings";
import { DEFAULT_LOCALE } from "../i18n/locales";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import type { Preferences } from "../persistence/mobile-preferences";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

const mapping = {
  toolCallVisibility: {
    read: (preferences) => preferences.toolCallVisibility ?? "showAll",
    write: (value) => ({ toolCallVisibility: value }),
  },
  showHighestReasoningEfforts: {
    read: (preferences) => preferences.showHighestReasoningEfforts ?? true,
    write: (value) => ({ showHighestReasoningEfforts: value }),
  },
  followUpBehavior: {
    read: (preferences) => preferences.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR,
    write: (value) => ({ followUpBehavior: value }),
  },
  language: {
    read: (preferences) => preferences.language ?? DEFAULT_LOCALE,
    write: (value) => ({ language: value }),
  },
  mathRenderingEnabled: {
    read: (preferences) => preferences.mathRenderingEnabled ?? false,
    write: (value) => ({ mathRenderingEnabled: value }),
  },
  sidebarWorkingShelfEnabled: {
    read: (preferences) => preferences.workingShelfEnabled ?? true,
    write: (value) => ({ workingShelfEnabled: value }),
  },
  sidebarProjectGroupingMode: {
    read: (preferences) =>
      resolveMobileProjectGroupingSettings(preferences).sidebarProjectGroupingMode,
    write: mobileProjectGroupingModePatch,
  },
} satisfies {
  [K in keyof SyncedClientSettingValues]: {
    read: (preferences: Preferences) => SyncedClientSettingValues[K];
    write: (value: SyncedClientSettingValues[K]) => Partial<Preferences>;
  };
};

export function mobileSyncedSettingValues(preferences: Preferences): SyncedClientSettingValues {
  return Object.fromEntries(
    SYNCED_CLIENT_SETTING_KEYS.map((key) => [key, mapping[key].read(preferences)]),
  ) as SyncedClientSettingValues;
}

export const MOBILE_SYNCED_SETTING_DEFAULTS = mobileSyncedSettingValues({});

export function stampMobilePreferencesPatch(
  current: Preferences,
  patch: Partial<Preferences>,
  now: number,
): Preferences {
  const next = { ...current, ...patch };
  return patch.settingsSyncTimestamps !== undefined
    ? next
    : {
        ...next,
        settingsSyncTimestamps: stampClientSettingsChanges(
          mobileSyncedSettingValues(current),
          mobileSyncedSettingValues(next),
          current.settingsSyncTimestamps ?? {},
          now,
        ),
      };
}

export function adoptMobileSettingsEntries(
  current: Preferences,
  entries: SyncedClientSettings,
): Partial<Preferences> {
  const adopted = adoptClientSettingsEntries(
    mobileSyncedSettingValues(current),
    current.settingsSyncTimestamps ?? {},
    entries,
  );
  const patch: Partial<Preferences> = { settingsSyncTimestamps: adopted.timestamps };
  const write = <K extends keyof SyncedClientSettingValues>(
    key: K,
    value: SyncedClientSettingValues[K],
  ) =>
    Object.assign(
      patch,
      (mapping[key].write as (value: SyncedClientSettingValues[K]) => Partial<Preferences>)(value),
    );
  for (const key of SYNCED_CLIENT_SETTING_KEYS) {
    const value = adopted.values[key];
    if (value !== undefined) write(key, value);
  }
  return patch;
}

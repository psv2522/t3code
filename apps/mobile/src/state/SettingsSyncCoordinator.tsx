import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  planClientSettingsSync,
  pushClientSettingsWithRetry,
} from "@t3tools/client-runtime/state/client-settings-sync";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SyncedClientSettings,
} from "@t3tools/contracts";
import { mergeSyncedClientSettings } from "@t3tools/shared/syncedClientSettings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironments } from "./environments";
import {
  mobilePreferencesAtom,
  mobilePreferencesLoadedSuccessfullyAtom,
  updateMobilePreferencesAtom,
} from "./preferences";
import { serverEnvironment } from "./server";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";
import {
  adoptMobileSettingsEntries,
  MOBILE_SYNCED_SETTING_DEFAULTS,
  mobileSyncedSettingValues,
} from "./settings-sync.logic";

const targetsAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) => {
    const connection = Option.getOrNull(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
    );
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    return connection?.phase === "connected" && settings?.syncedClientSettings !== undefined
      ? [
          {
            environmentId,
            generation: connection.generation,
            settings: settings.syncedClientSettings,
          },
        ]
      : [];
  }),
).pipe(Atom.withLabel("mobile:settings-sync:targets"));

export function SettingsSyncCoordinator() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updating = useAtomValue(updateMobilePreferencesAtom);
  const loaded = useAtomValue(mobilePreferencesLoadedSuccessfullyAtom);
  const targets = useAtomValue(targetsAtom);
  const { environments } = useEnvironments();
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const pushSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const pending = useRef(
    new Map<
      EnvironmentId,
      { generation: number; entries: SyncedClientSettings; controller: AbortController }
    >(),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels retry timers when the coordinator unmounts
  useEffect(() => {
    const writes = pending.current;
    return () => {
      for (const state of writes.values()) state.controller.abort();
      writes.clear();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replicates persisted preferences to connected servers and adopts their newer values
  useEffect(() => {
    const enabled =
      loaded &&
      AsyncResult.isSuccess(preferences) &&
      preferences.value.settingsSyncEnabled === true;
    for (const [id, state] of pending.current) {
      if (
        !enabled ||
        !writable.has(id) ||
        !targets.some(
          (target) => target.environmentId === id && target.generation === state.generation,
        )
      ) {
        state.controller.abort();
        pending.current.delete(id);
      }
    }
    if (
      updating.waiting ||
      !loaded ||
      !AsyncResult.isSuccess(preferences) ||
      preferences.waiting ||
      !preferences.value.settingsSyncEnabled
    )
      return;
    const plan = planClientSettingsSync({
      values: mobileSyncedSettingValues(preferences.value),
      timestamps: preferences.value.settingsSyncTimestamps ?? {},
      defaults: MOBILE_SYNCED_SETTING_DEFAULTS,
      now: Date.now(),
      environments: targets.map((target) => ({
        ...target,
        writable: writable.has(target.environmentId),
        inFlight: pending.current.get(target.environmentId)?.entries,
      })),
    });
    const entries = { ...plan.adopts, ...plan.seeds };
    if (Object.keys(entries).length > 0)
      save({ transform: (current) => adoptMobileSettingsEntries(current, entries) });
    for (const push of plan.pushes) {
      const target = targets.find((target) => target.environmentId === push.environmentId)!;
      const state = {
        generation: target.generation,
        controller: pending.current.get(push.environmentId)?.controller ?? new AbortController(),
        entries: mergeSyncedClientSettings(
          pending.current.get(push.environmentId)?.entries ?? {},
          push.syncedClientSettings,
        ),
      };
      pending.current.set(push.environmentId, state);
      void pushClientSettingsWithRetry(async () => {
        const result = await pushSettings({
          environmentId: push.environmentId,
          input: { patch: { syncedClientSettings: push.syncedClientSettings } },
        });
        return result._tag === "Success";
      }, state.controller.signal);
    }
  }, [loaded, updating.waiting, preferences, targets, writable, save, pushSettings]);
  return null;
}

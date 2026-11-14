import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { supportsClientSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "../../i18n/I18nProvider";
import { useEnvironments } from "../../state/environments";
import {
  mobilePreferencesAtom,
  mobilePreferencesLoadedSuccessfullyAtom,
  updateMobilePreferencesAtom,
} from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsSyncSection() {
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = useAtomValue(mobilePreferencesLoadedSuccessfullyAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const { environments } = useEnvironments();
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.settingsSyncEnabled === true;
  const description = gt(
    "Sync tool call visibility, highest reasoning levels, follow-up behavior, language, math rendering, the working section, and project grouping. The newest change wins.",
  );
  return (
    <SettingsSection title={gt("Settings sync")}>
      <SettingsSwitchRow
        label={gt("Sync settings across devices")}
        subtitle={
          enabled && !environments.some(supportsClientSettingsSync)
            ? `${description} ${gt("No connected environment supports settings sync.")}`
            : description
        }
        value={enabled}
        disabled={!loaded}
        onValueChange={(value) => save({ settingsSyncEnabled: value })}
      />
    </SettingsSection>
  );
}

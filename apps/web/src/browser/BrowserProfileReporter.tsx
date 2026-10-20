import {
  AuthPreviewOperateScope,
  type BrowserProfile,
  type BrowserRecordingFrameRate,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const selectProfiles = (settings: { readonly browserProfiles: ReadonlyArray<BrowserProfile> }) =>
  settings.browserProfiles;
const selectDefaultProfileId = (settings: { readonly browserDefaultProfileId: string }) =>
  settings.browserDefaultProfileId;
const selectRecordingFrameRate = (settings: {
  readonly browserRecordingFrameRate: BrowserRecordingFrameRate;
}) => settings.browserRecordingFrameRate;

export function BrowserProfileReporter() {
  const hydrated = useClientSettingsHydrated();
  const profiles = useClientSettings(selectProfiles);
  const defaultProfileId = useClientSettings(selectDefaultProfileId);
  const recordingFrameRate = useClientSettings(selectRecordingFrameRate);
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const operable = useEnvironmentsWithScope(environments, AuthPreviewOperateScope);
  const report = useAtomCommand(previewEnvironment.reportProfiles, { reportFailure: false });
  const reported = useRef(new Map<EnvironmentId, string>());
  const connectedKey = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId)
    .join("\n");

  useEffect(() => {
    if (!hydrated) return;
    const connected = new Set<string>(connectedKey.split("\n"));
    for (const environmentId of reported.current.keys()) {
      if (!connected.has(environmentId)) reported.current.delete(environmentId);
    }
    const payload = JSON.stringify([profiles, defaultProfileId, recordingFrameRate]);
    for (const [environmentId, config] of serverConfigs) {
      if (!config.environment.capabilities.serverBrowser || !operable.has(environmentId)) continue;
      if (!connected.has(environmentId) || reported.current.get(environmentId) === payload)
        continue;
      reported.current.set(environmentId, payload);
      void report({
        environmentId,
        input: { profiles, defaultProfileId, recordingFrameRate },
      }).then((result) => {
        if (result._tag !== "Success" && reported.current.get(environmentId) === payload) {
          reported.current.delete(environmentId);
        }
      });
    }
  }, [
    connectedKey,
    defaultProfileId,
    hydrated,
    operable,
    profiles,
    recordingFrameRate,
    report,
    serverConfigs,
  ]);

  return null;
}

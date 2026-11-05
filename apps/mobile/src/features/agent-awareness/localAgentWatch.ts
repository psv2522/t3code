import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { AppState, Platform } from "react-native";

import {
  isBackgroundWatchActive,
  nudgeConnections,
  setBackgroundWatchActive,
} from "../../connection/background-watch";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import {
  onAndroidBackgroundWatchTick,
  setAndroidLocalUpdatesEnabled,
  showAndroidLocalActivity,
  startAndroidBackgroundWatch,
  stopAndroidBackgroundWatch,
  supportsAndroidBackgroundWatch,
} from "./androidNotifications";
import {
  advanceLocalActivityWatch,
  buildLocalActivityPayload,
  collectLocalActivityRows,
  INITIAL_LOCAL_ACTIVITY_WATCH_STATE,
  type LocalActivityRow,
  localActivityPayloadSignature,
} from "./localAgentActivity";
import {
  getAgentAwarenessRegistrationStatus,
  subscribeAgentAwarenessRegistrationStatus,
} from "./remoteRegistration";
import { threadModelResolverFor } from "./threadModelDisplay";

const REPOST_AFTER_MS = 30 * 60_000;
const EMPTY_SIGNATURE = localActivityPayloadSignature(buildLocalActivityPayload([], 0));

const shellSnapshotsAtom = Atom.make((get) => {
  const snapshots = new Map<EnvironmentId, OrchestrationV2ShellSnapshot>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const { snapshot } = get(environmentShell.stateValueAtom(environmentId));
    if (Option.isSome(snapshot)) snapshots.set(environmentId, snapshot.value);
  }
  return snapshots;
}).pipe(Atom.withLabel("mobile:local-agent-watch-snapshots"));

function hasDisconnectedEnvironment(): boolean {
  for (const environmentId of enabledEnvironmentIds(
    appAtomRegistry.get(environmentCatalog.catalogValueAtom),
  )) {
    if (!appAtomRegistry.get(environmentConnectedAtom(environmentId))) return true;
  }
  return false;
}

function startWatching(): () => void {
  setAndroidLocalUpdatesEnabled(true);
  let state = INITIAL_LOCAL_ACTIVITY_WATCH_STATE;
  let lastSignature = EMPTY_SIGNATURE;
  let lastPostedAt = 0;
  let scheduled = false;
  let disposed = false;

  const ensureService = () => {
    if (!isBackgroundWatchActive() && startAndroidBackgroundWatch()) {
      setBackgroundWatchActive(true);
    }
  };

  const process = () => {
    scheduled = false;
    if (disposed) return;
    // Environments that publish through T3 Connect already reach this device by push.
    const coveredByPush = getAgentAwarenessRegistrationStatus() === "registered";
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const rowsByEnvironment = new Map<EnvironmentId, ReadonlyArray<LocalActivityRow>>();
    for (const [environmentId, snapshot] of appAtomRegistry.get(shellSnapshotsAtom)) {
      const config = configs.get(environmentId);
      if (coveredByPush && config?.environment.capabilities.agentActivityPublishing === true) {
        continue;
      }
      rowsByEnvironment.set(
        environmentId,
        collectLocalActivityRows(
          environmentId,
          snapshot.projects,
          snapshot.threads,
          config ? threadModelResolverFor(config) : undefined,
        ),
      );
    }
    const now = Date.now();
    const next = advanceLocalActivityWatch(state, rowsByEnvironment, now);
    state = next.state;
    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    const alertsEnabled =
      AsyncResult.isSuccess(preferences) && preferences.value.backgroundWatchAlerts === true;
    const alerts = alertsEnabled ? next.alerts : [];
    const cardRows = alertsEnabled
      ? next.rows
      : next.rows.filter((row) => row.terminalAt === undefined);
    const payload = buildLocalActivityPayload(cardRows, next.activeCount);
    const signature = localActivityPayloadSignature(payload);
    const changed =
      signature !== lastSignature || (next.activeCount > 0 && now - lastPostedAt > REPOST_AFTER_MS);
    if (alerts.length === 0) {
      if (changed) showAndroidLocalActivity(payload);
    } else {
      for (const alert of alerts) {
        showAndroidLocalActivity({
          ...payload,
          alert_id: alert.id,
          alert_group: alert.group,
          alert_title: alert.title,
          alert_body: alert.body,
          alert_path: alert.path,
        });
      }
    }
    if (changed || alerts.length > 0) {
      lastSignature = signature;
      lastPostedAt = now;
    }
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(process);
  };

  ensureService();
  const unsubscribes = [
    appAtomRegistry.subscribe(shellSnapshotsAtom, schedule),
    appAtomRegistry.subscribe(environmentServerConfigsAtom, schedule),
    subscribeAgentAwarenessRegistrationStatus(schedule),
    (() => {
      const subscription = AppState.addEventListener("change", (appState) => {
        if (appState === "active") ensureService();
      });
      return () => subscription.remove();
    })(),
    // JS timers do not fire in the background with the screen off, so this native tick is the only clock.
    onAndroidBackgroundWatchTick(() => {
      if (AppState.currentState !== "active" && hasDisconnectedEnvironment()) nudgeConnections();
    }),
  ];
  schedule();

  return () => {
    disposed = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    stopAndroidBackgroundWatch();
    setBackgroundWatchActive(false);
    setAndroidLocalUpdatesEnabled(false);
  };
}

/** Runs only while the "Background updates" preference is on. */
export function installLocalAgentWatch(): () => void {
  if (Platform.OS !== "android" || !supportsAndroidBackgroundWatch()) return () => {};
  let stopWatching: (() => void) | null = null;
  const unsubscribe = appAtomRegistry.subscribe(
    mobilePreferencesAtom,
    (result) => {
      const enabled = AsyncResult.isSuccess(result) && result.value.backgroundWatchEnabled === true;
      if (enabled && stopWatching === null) {
        stopWatching = startWatching();
      } else if (!enabled && stopWatching !== null) {
        stopWatching();
        stopWatching = null;
      }
    },
    { immediate: true },
  );
  return () => {
    unsubscribe();
    stopWatching?.();
    stopWatching = null;
  };
}

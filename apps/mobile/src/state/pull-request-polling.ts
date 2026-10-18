import { pullRequestPollingEnabledAtom } from "@t3tools/client-runtime/state/pull-requests";
import { useEffect } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "./atom-registry";

function syncPolling(state: string | null | undefined) {
  appAtomRegistry.set(
    pullRequestPollingEnabledAtom,
    state !== "background" && state !== "inactive",
  );
}

export function usePullRequestPollingWhileActive() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors AppState into the polling atom while mounted
  useEffect(() => {
    syncPolling(AppState.currentState);
    const subscription = AppState.addEventListener("change", syncPolling);
    return () => subscription.remove();
  }, []);
}

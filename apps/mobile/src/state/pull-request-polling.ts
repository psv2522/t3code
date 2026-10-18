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
  useEffect(() => {
    syncPolling(AppState.currentState);
    const subscription = AppState.addEventListener("change", syncPolling);
    return () => subscription.remove();
  }, []);
}

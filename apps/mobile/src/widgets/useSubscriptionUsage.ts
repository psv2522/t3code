import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { use, useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  createWidgetRefresher,
  usageLimitsCheckedAt,
  WIDGET_REFRESH_INTERVAL,
} from "./subscriptionUsageSnapshot";

export function useSubscriptionUsage(enabled = true) {
  const registry = use(RegistryContext);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refresh = useMemo(
    () =>
      createWidgetRefresher(
        (environmentId: Parameters<typeof refreshProviders>[0]["environmentId"]) =>
          refreshProviders({ environmentId, input: {} }),
      ),
    [refreshProviders],
  );

  useEffect(() => {
    const update = () => {
      if (!enabled || AppState.currentState !== "active") return;
      const now = Date.now();
      // Read without subscribing: provider pushes must not restart the interval.
      const providers = registry.get(environmentPresentations.providersByEnvironmentAtom);
      const stale = [...presentations]
        .filter(
          ([id, presentation]) =>
            presentation.connection.phase === "connected" &&
            now - usageLimitsCheckedAt(providers.get(id) ?? []) >= WIDGET_REFRESH_INTERVAL,
        )
        .map(([id]) => id);
      void refresh(stale, now);
    };
    update();
    const subscription = AppState.addEventListener("change", update);
    const timer = setInterval(update, WIDGET_REFRESH_INTERVAL);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [enabled, presentations, refresh, registry]);
}

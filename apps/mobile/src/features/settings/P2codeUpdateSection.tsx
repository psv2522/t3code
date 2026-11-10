import {
  createP2codeUpdateWatcher,
  describeP2codeUpdate,
  resolveP2codeCheck,
  type P2codeUpdateCall,
} from "@t3tools/client-runtime/p2codeUpdate";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isP2codeUpdateRunning,
  type EnvironmentId,
  type P2codeUpdateResult,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { isAppActive, subscribeAppState } from "../../lib/appState";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";

function makeCall(environmentId: EnvironmentId): P2codeUpdateCall {
  return async (action) => {
    const result = await serverEnvironment.p2codeUpdate.run(appAtomRegistry, {
      environmentId,
      input: { action },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  };
}

export function P2codeUpdateSection({
  environmentId,
  label,
  version,
  connected,
  allowed,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly version: string | undefined;
  readonly connected: boolean;
  readonly allowed: boolean;
}) {
  const [progress, setProgress] = useState<P2codeUpdateResult | null>(null);
  const [checked, setChecked] = useState<P2codeUpdateResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watching = useRef<ReturnType<typeof createP2codeUpdateWatcher> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a server-side job while the screen and app are active
  useEffect(() => {
    if (!connected || !allowed) return;
    const watcher = createP2codeUpdateWatcher({
      call: makeCall(environmentId),
      active: isAppActive(),
      onProgress: (status) => {
        setProgress(status);
        if (isP2codeUpdateRunning(status.phase)) setChecked(null);
      },
    });
    watching.current = watcher;
    const unsubscribe = subscribeAppState(() => watcher.setActive(isAppActive()));
    return () => {
      unsubscribe();
      watcher.dispose();
      if (watching.current === watcher) watching.current = null;
    };
  }, [environmentId, connected, allowed]);

  const running = progress !== null && isP2codeUpdateRunning(progress.phase);
  const outcome = checked === null ? null : resolveP2codeCheck(checked);
  const statusText = progress === null ? null : describeP2codeUpdate(progress);
  const disabled = !connected || !allowed || checking || running;

  async function check() {
    if (disabled) return;
    const watcher = watching.current;
    setChecking(true);
    setError(null);
    const outcome = await makeCall(environmentId)("check").then(
      (result) => ({ result }),
      (cause: unknown) => ({ cause }),
    );
    setChecking(false);
    if (watching.current !== watcher) return;
    if ("result" in outcome) {
      setChecked(outcome.result);
      if (isP2codeUpdateRunning(outcome.result.phase)) watcher?.update(outcome.result);
    } else {
      setError(outcome.cause instanceof Error ? outcome.cause.message : "The update check failed.");
    }
  }

  function requestUpdate() {
    if (disabled || outcome?.kind !== "available") return;
    const watcher = watching.current;
    Dialog.alert(
      `Update ${label}?`,
      `${outcome.changes.map((change) => `• ${change}`).join("\n")}\n\nIt syncs, builds and installs on that machine. T3 Code restarts and reconnects. Running threads may be interrupted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update",
          onPress: () => {
            if (!watcher || watching.current !== watcher) return;
            setError(null);
            setChecked(null);
            void makeCall(environmentId)("start").then(
              (status) => watcher.update(status),
              (cause: unknown) => {
                if (watching.current === watcher) {
                  setError(cause instanceof Error ? cause.message : "The update could not start.");
                }
              },
            );
          },
        },
      ],
    );
  }

  const failure = error ?? (progress?.phase === "failed" ? statusText : null);

  return (
    <SettingsSection title="T3 Code">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {version ? `Version ${version}` : "p2code build"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {running
            ? statusText
            : outcome?.kind === "available"
              ? outcome.changes.join(" and ")
              : outcome?.kind === "up-to-date"
                ? "You are up to date."
                : outcome?.kind === "dirty"
                  ? "Commit the changes in the p2code repo on that machine first."
                  : progress?.phase === "done" && progress.message
                    ? progress.message
                    : "Updates come from the p2code repo on that machine."}
        </Text>
        {failure ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {failure}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Check for updates"
        disabled={disabled}
        loading={checking}
        onPress={() => void check()}
      />
      {outcome?.kind === "available" ? (
        <SettingsActionRow
          icon="arrow.up.circle"
          label="Update now"
          disabled={disabled}
          loading={running}
          onPress={requestUpdate}
        />
      ) : null}
    </SettingsSection>
  );
}

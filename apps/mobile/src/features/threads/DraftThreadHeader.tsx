import { uuidv4 } from "../../lib/uuid";
import * as Dialog from "../../components/ui/Dialog";
import { useNavigation } from "@react-navigation/native";
import { vcsActionLabelText } from "@t3tools/client-runtime/state/vcs";
import { useGT, useMessages } from "gt-react-native";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  AuthFilesystemReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_SERVER_SETTINGS,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "../../state/vcs";
import { useVcsActionState } from "../../state/use-vcs-action-state";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { stagePendingTerminalLaunch } from "../terminal/terminalLaunchContext";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import { ThreadHeader } from "./ThreadHeader";

export function DraftThreadHeader(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
  readonly cwd: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const environmentId = props.thread.environmentId;
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWriteGit = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const status = useEnvironmentQuery(
    props.cwd ? vcsEnvironment.status({ environmentId, input: { cwd: props.cwd } }) : null,
  );
  const target = { environmentId, cwd: props.cwd };
  const progress = useVcsActionState(target);
  const runAction = useAtomCommand(vcsActionManager.runStackedAction(target), {
    reportFailure: false,
  });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const openFiles = () => {
    if (!props.cwd || !canReadFiles) return;
    navigation.navigate("NewTaskFiles", {
      environmentId,
      cwd: props.cwd,
      projectName: props.project.title,
    });
  };
  const requiresThread = () =>
    Dialog.alert(gt("Available after the first message"), gt("This action needs a saved thread."));
  const canReadTerminal = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const serverSettings = useRemoteEnvironmentRuntime(environmentId)?.serverConfig?.settings;
  const { sessions: knownTerminalSessions } = useKnownTerminalSessions({
    environmentId,
    threadId: props.thread.id,
  });
  const terminalSessions = buildTerminalMenuSessions({
    knownSessions: knownTerminalSessions ?? [],
    workspaceRoot: props.project.workspaceRoot,
  });
  const worktreePath =
    props.cwd !== null && props.cwd !== props.project.workspaceRoot ? props.cwd : null;
  const uniqueTerminalSuffix =
    knownTerminalSessions === null || !canReadTerminal ? { uniqueSuffix: uuidv4() } : {};
  const openTerminal = (terminalId?: string | null) => {
    navigation.navigate("ThreadTerminal", {
      environmentId: String(environmentId),
      threadId: String(props.thread.id),
      draftProjectId: String(props.project.id),
      ...(worktreePath ? { draftWorktreePath: worktreePath } : {}),
      ...(terminalId ? { terminalId } : {}),
    });
  };
  const openNewTerminal = () => {
    if (!canOperateTerminal) return;
    openTerminal(
      nextOpenTerminalId({
        listedTerminalIds: terminalSessions.map((session) => session.terminalId),
        ...uniqueTerminalSuffix,
      }),
    );
  };
  const runProjectScript = async (script: ProjectScript) => {
    if (!canOperateTerminal) return;
    const terminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: terminalSessions.map((session) => session.terminalId),
      ...uniqueTerminalSuffix,
      hasRunningTerminal: terminalSessions.some(
        (session) => session.status === "running" || session.status === "starting",
      ),
    });
    const scriptTarget = { project: { cwd: props.project.workspaceRoot }, worktreePath };
    stagePendingTerminalLaunch({
      target: { environmentId, threadId: props.thread.id, terminalId },
      launch: {
        cwd: projectScriptCwd(scriptTarget),
        worktreePath,
        env: projectScriptRuntimeEnv(scriptTarget),
        initialInput: projectScriptTerminalInput(script.command),
        stopOnSettle: script.stopOnSettle ?? false,
      },
    });
    openTerminal(terminalId);
  };
  return (
    <ThreadHeader
      draft
      title={gt("New thread")}
      subtitle=""
      hasThreadCwd={props.cwd !== null}
      inspectorMode={null}
      onOpenFilesInspector={openFiles}
      gitControls={{
        environmentId,
        threadId: props.thread.id,
        hasThread: false,
        currentBranch: props.thread.branch,
        gitStatus: status.data,
        gitOperationLabel: vcsActionLabelText(progress, messages),
        canOpenTerminal:
          Boolean(props.project.workspaceRoot) && (canReadTerminal || canOperateTerminal),
        canOperateTerminal,
        canOpenFiles: canReadFiles && props.cwd !== null,
        projectScripts: resolveProjectScripts(
          serverSettings ?? DEFAULT_SERVER_SETTINGS,
          props.project,
        ),
        terminalSessions,
        onOpenFilesInspector: openFiles,
        onOpenGitInspector: requiresThread,
        onOpenTerminal: openTerminal,
        onOpenNewTerminal: openNewTerminal,
        onRunProjectScript: runProjectScript,
        onPull: async () => {
          if (!canWriteGit || !props.cwd) return;
          const result = await pull({ environmentId, input: { cwd: props.cwd } });
          if (AsyncResult.isFailure(result))
            Dialog.alert(gt("Could not pull"), String(Cause.squash(result.cause)));
        },
        onRunAction: async (input) => {
          if (!canWriteGit || !props.cwd) return null;
          const result = await runAction({
            ...input,
            projectId: props.project.id,
            actionId: uuidv4(),
          });
          if (AsyncResult.isFailure(result)) {
            Dialog.alert(gt("Git action failed"), String(Cause.squash(result.cause)));
            return null;
          }
          return result.value;
        },
      }}
    />
  );
}

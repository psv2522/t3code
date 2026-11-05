import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { type AgentAwarenessPhase, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";

import type { ThreadModelResolver } from "./threadModelDisplay";

const MAX_ROWS = 5;
const TERMINAL_TTL_MS = 15 * 60_000;
const RUNNING_TTL_MS = 2 * 60 * 60_000;
const WAITING_TTL_MS = 24 * 60 * 60_000;

export interface LocalActivityRow {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly phase: AgentAwarenessPhase;
  readonly threadTitle: string;
  readonly projectTitle: string;
  readonly deepLink: string;
  readonly updatedAtMs: number;
  readonly modelLabel?: string;
}

export interface LocalActivityCardRow extends LocalActivityRow {
  readonly terminalAt?: number;
}

export interface LocalActivityAlert {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly body: string;
  readonly path: string;
}

export interface LocalActivityWatchState {
  readonly phases: ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, AgentAwarenessPhase>>;
  readonly terminalAt: ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, number>>;
}

export const INITIAL_LOCAL_ACTIVITY_WATCH_STATE: LocalActivityWatchState = {
  phases: new Map(),
  terminalAt: new Map(),
};

const isTerminal = (phase: AgentAwarenessPhase) => phase === "completed" || phase === "failed";
const isAttention = (phase: AgentAwarenessPhase) =>
  phase === "waiting_for_approval" || phase === "waiting_for_input";

function phasePriority(phase: AgentAwarenessPhase): number {
  if (isAttention(phase)) return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}

function statusForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

const rowMemo = new WeakMap<
  OrchestrationV2ThreadShell,
  {
    readonly projectTitle: string;
    readonly resolveModel: ThreadModelResolver | undefined;
    readonly row: LocalActivityRow | null;
  }
>();

function rowForThread(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
  projectTitle: string,
  resolveModel: ThreadModelResolver | undefined,
): LocalActivityRow | null {
  const cached = rowMemo.get(thread);
  if (cached?.projectTitle === projectTitle && cached.resolveModel === resolveModel) {
    return cached.row;
  }
  const state = projectThreadAwarenessV2({
    environmentId,
    project: { title: projectTitle },
    thread,
  });
  const model = state === null ? null : (resolveModel?.(thread) ?? null);
  const row =
    state === null
      ? null
      : {
          environmentId,
          threadId: state.threadId,
          phase: state.phase,
          threadTitle: state.threadTitle,
          projectTitle: state.projectTitle,
          deepLink: state.deepLink,
          updatedAtMs: Date.parse(state.updatedAt),
          ...(model ? { modelLabel: model.label } : {}),
        };
  rowMemo.set(thread, { projectTitle, resolveModel, row });
  return row;
}

/** Unchanged threads keep their identity across shell updates, so only changed ones are projected. */
export function collectLocalActivityRows(
  environmentId: EnvironmentId,
  projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "title">>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  resolveModel?: ThreadModelResolver,
): ReadonlyArray<LocalActivityRow> {
  const titles = new Map(projects.map((project) => [project.id, project.title]));
  const rows: LocalActivityRow[] = [];
  for (const thread of threads) {
    const projectTitle = titles.get(thread.projectId);
    if (projectTitle === undefined || thread.archivedAt !== null) continue;
    const row = rowForThread(environmentId, thread, projectTitle, resolveModel);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function alertFor(row: LocalActivityRow, now: number): LocalActivityAlert {
  return {
    id: JSON.stringify([row.environmentId, row.threadId, row.phase, now]),
    group: JSON.stringify([row.environmentId, row.threadId]),
    title: row.threadTitle,
    body: `${statusForPhase(row.phase)}: ${row.projectTitle}`,
    path: row.deepLink,
  };
}

/**
 * A thread is only alerted on a change this device saw, so the first snapshot of an
 * environment and threads that were already finished are a baseline, never a notification.
 */
export function advanceLocalActivityWatch(
  state: LocalActivityWatchState,
  rowsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<LocalActivityRow>>,
  now: number,
): {
  readonly state: LocalActivityWatchState;
  readonly alerts: ReadonlyArray<LocalActivityAlert>;
  readonly rows: ReadonlyArray<LocalActivityCardRow>;
  readonly activeCount: number;
} {
  const phases = new Map<EnvironmentId, ReadonlyMap<ThreadId, AgentAwarenessPhase>>();
  const terminalAt = new Map<EnvironmentId, ReadonlyMap<ThreadId, number>>();
  const alerts: LocalActivityAlert[] = [];
  const rows: LocalActivityCardRow[] = [];
  let activeCount = 0;

  for (const [environmentId, environmentRows] of rowsByEnvironment) {
    const previousPhases = state.phases.get(environmentId);
    const previousTerminalAt = state.terminalAt.get(environmentId);
    const nextPhases = new Map<ThreadId, AgentAwarenessPhase>();
    const nextTerminalAt = new Map<ThreadId, number>();
    for (const row of environmentRows) {
      const previous = previousPhases?.get(row.threadId);
      nextPhases.set(row.threadId, row.phase);
      if (isTerminal(row.phase)) {
        const finishedNow = previous !== undefined && !isTerminal(previous);
        const finishedAt = finishedNow ? now : previousTerminalAt?.get(row.threadId);
        if (finishedNow) alerts.push(alertFor(row, now));
        if (finishedAt !== undefined && now - finishedAt <= TERMINAL_TTL_MS) {
          nextTerminalAt.set(row.threadId, finishedAt);
          rows.push({ ...row, terminalAt: finishedAt });
        }
        continue;
      }
      activeCount += 1;
      rows.push(row);
      if (
        isAttention(row.phase) &&
        previous !== row.phase &&
        (previous !== undefined || previousPhases !== undefined)
      ) {
        alerts.push(alertFor(row, now));
      }
    }
    phases.set(environmentId, nextPhases);
    terminalAt.set(environmentId, nextTerminalAt);
  }

  return { state: { phases, terminalAt }, alerts, rows, activeCount };
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

function expiresAt(row: LocalActivityCardRow): number {
  if (row.terminalAt !== undefined) return row.terminalAt + TERMINAL_TTL_MS;
  return (
    row.updatedAtMs +
    (row.phase === "running" || row.phase === "starting" ? RUNNING_TTL_MS : WAITING_TTL_MS)
  );
}

/** The same key set the relay sends over FCM, so the native card renders it unchanged. */
export function buildLocalActivityPayload(
  cardRows: ReadonlyArray<LocalActivityCardRow>,
  activeCount: number,
): Record<string, string> {
  const active = cardRows.filter((row) => !isTerminal(row.phase));
  const byPriority = (a: LocalActivityCardRow, b: LocalActivityCardRow) =>
    phasePriority(a.phase) - phasePriority(b.phase);
  const recent = cardRows
    .filter((row) => isTerminal(row.phase))
    .sort((a, b) => (b.terminalAt ?? 0) - (a.terminalAt ?? 0));
  const rows = [...active.sort(byPriority), ...recent].slice(0, MAX_ROWS).sort(byPriority);
  const attentionCount = rows.filter((row) => phasePriority(row.phase) === 0).length;
  const failed = rows.some((row) => row.phase === "failed");
  const hero = rows[0];
  const title =
    activeCount > 0
      ? `${activeCount} active agent${activeCount === 1 ? "" : "s"}${attentionCount ? ` · ${attentionCount} need${attentionCount === 1 ? "s" : ""} attention` : ""}`
      : failed
        ? "Agent work failed"
        : "Agent work completed";
  return {
    active: String(activeCount > 0),
    activity_chip: activeCount > 0 ? (attentionCount > 0 ? "Review" : "Active") : "",
    activity_title: title,
    activity_phase: hero?.phase ?? "",
    activity_active_count: String(activeCount),
    activity_attention_count: String(attentionCount),
    activity_body: hero
      ? `${statusForPhase(hero.phase)}: ${clean(hero.threadTitle)} · ${clean(hero.projectTitle)}`
      : "",
    ...Object.fromEntries(
      rows.map((row, index) => [
        `activity_line_${index}`,
        [
          statusForPhase(row.phase),
          clean(row.threadTitle),
          clean(row.projectTitle),
          ...(row.modelLabel ? [clean(row.modelLabel)] : []),
        ].join("\t"),
      ]),
    ),
    activity_path: hero?.deepLink ?? "/",
    activity_expires_at: String(Math.max(0, ...rows.map(expiresAt))),
  };
}

/** Everything that changes what the card shows; expiry is excluded so streaming does not repost it. */
export function localActivityPayloadSignature(payload: Record<string, string>): string {
  const { activity_expires_at: _expiresAt, ...visible } = payload;
  return JSON.stringify(visible);
}

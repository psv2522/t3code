import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceLocalActivityWatch,
  buildLocalActivityPayload,
  INITIAL_LOCAL_ACTIVITY_WATCH_STATE,
  type LocalActivityRow,
  localActivityPayloadSignature,
} from "./localAgentActivity";

const environmentId = "env-1" as EnvironmentId;

function row(threadId: string, phase: AgentAwarenessPhase, title = threadId): LocalActivityRow {
  return {
    environmentId,
    threadId: threadId as ThreadId,
    phase,
    threadTitle: title,
    projectTitle: "Project",
    deepLink: `/threads/${threadId}`,
    updatedAtMs: 1_000,
  };
}

const rowsOf = (...rows: LocalActivityRow[]) => new Map([[environmentId, rows]]);

describe("advanceLocalActivityWatch", () => {
  it("baselines the first snapshot without alerts", () => {
    const first = advanceLocalActivityWatch(
      INITIAL_LOCAL_ACTIVITY_WATCH_STATE,
      rowsOf(row("a", "running"), row("b", "waiting_for_input"), row("c", "completed")),
      10,
    );
    expect(first.alerts).toEqual([]);
    expect(first.activeCount).toBe(2);
    expect(first.rows.map((entry) => entry.threadId)).not.toContain("c");
  });

  it("alerts when a watched thread finishes, then keeps it on the card until the TTL", () => {
    const baseline = advanceLocalActivityWatch(
      INITIAL_LOCAL_ACTIVITY_WATCH_STATE,
      rowsOf(row("a", "running")),
      0,
    );
    const finished = advanceLocalActivityWatch(baseline.state, rowsOf(row("a", "completed")), 100);
    expect(finished.alerts).toHaveLength(1);
    expect(finished.alerts[0]).toMatchObject({
      title: "a",
      body: "Done: Project",
      path: "/threads/a",
    });
    expect(finished.rows).toHaveLength(1);

    const later = advanceLocalActivityWatch(finished.state, rowsOf(row("a", "completed")), 200);
    expect(later.alerts).toEqual([]);
    expect(later.rows).toHaveLength(1);

    const expired = advanceLocalActivityWatch(
      later.state,
      rowsOf(row("a", "completed")),
      100 + 15 * 60_000 + 1,
    );
    expect(expired.rows).toEqual([]);
  });

  it("alerts once when a thread starts waiting, including a thread first seen after the baseline", () => {
    const baseline = advanceLocalActivityWatch(
      INITIAL_LOCAL_ACTIVITY_WATCH_STATE,
      rowsOf(row("a", "running")),
      0,
    );
    const waiting = advanceLocalActivityWatch(
      baseline.state,
      rowsOf(row("a", "waiting_for_approval"), row("b", "waiting_for_input")),
      10,
    );
    expect(waiting.alerts.map((alert) => alert.path)).toEqual(["/threads/a", "/threads/b"]);

    const unchanged = advanceLocalActivityWatch(
      waiting.state,
      rowsOf(row("a", "waiting_for_approval"), row("b", "waiting_for_input")),
      20,
    );
    expect(unchanged.alerts).toEqual([]);
  });
});

describe("buildLocalActivityPayload", () => {
  it("uses the relay key set and orders attention rows first", () => {
    const payload = buildLocalActivityPayload(
      [row("a", "running", "Build"), row("b", "waiting_for_approval", "Deploy")],
      2,
    );
    expect(payload).toMatchObject({
      active: "true",
      activity_chip: "Review",
      activity_title: "2 active agents · 1 needs attention",
      activity_phase: "waiting_for_approval",
      activity_path: "/threads/b",
      activity_line_0: "Approval\tDeploy\tProject",
      activity_line_1: "Working\tBuild\tProject",
    });
  });

  it("appends the model to its line", () => {
    const payload = buildLocalActivityPayload(
      [
        {
          ...row("a", "running", "Build"),
          modelLabel: "Sonnet 5.5 High",
        },
        row("b", "running", "Test"),
      ],
      2,
    );
    expect(payload).toMatchObject({
      activity_line_0: "Working\tBuild\tProject\tSonnet 5.5 High",
      activity_line_1: "Working\tTest\tProject",
    });
  });

  it("reports a finished card without the active flag", () => {
    const payload = buildLocalActivityPayload([{ ...row("a", "failed"), terminalAt: 5 }], 0);
    expect(payload).toMatchObject({ active: "false", activity_title: "Agent work failed" });
  });

  it("keeps the signature stable when only the expiry moves", () => {
    const first = buildLocalActivityPayload([row("a", "running")], 1);
    const second = { ...first, activity_expires_at: "999" };
    expect(localActivityPayloadSignature(second)).toBe(localActivityPayloadSignature(first));
  });
});

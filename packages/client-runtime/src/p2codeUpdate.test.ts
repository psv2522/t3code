import type { P2codeUpdateResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachP2codeUpdate, resolveP2codeCheck, watchP2codeUpdate } from "./p2codeUpdate.ts";

const result = (overrides: Partial<P2codeUpdateResult>): P2codeUpdateResult => ({
  phase: "idle",
  message: null,
  threadId: null,
  version: null,
  upstreamCommits: 0,
  localChanges: false,
  dirty: false,
  ...overrides,
});

describe("resolveP2codeCheck", () => {
  it("reports up to date when nothing is pending", () => {
    expect(resolveP2codeCheck(result({}))).toEqual({ kind: "up-to-date" });
  });

  it("lists upstream and local changes", () => {
    expect(resolveP2codeCheck(result({ upstreamCommits: 4, localChanges: true }))).toEqual({
      kind: "available",
      changes: ["4 new upstream commits", "p2code changes made since the last install"],
    });
    expect(resolveP2codeCheck(result({ upstreamCommits: 1 }))).toEqual({
      kind: "available",
      changes: ["1 new upstream commit"],
    });
  });

  it("refuses to start over uncommitted changes", () => {
    expect(resolveP2codeCheck(result({ upstreamCommits: 2, dirty: true }))).toEqual({
      kind: "dirty",
    });
  });

  it("attaches to an update that is already running", () => {
    for (const phase of ["building", "conflict"] as const) {
      expect(resolveP2codeCheck(result({ phase, upstreamCommits: 2 }))).toEqual({
        kind: "running",
      });
    }
  });
});

describe("watchP2codeUpdate", () => {
  it("rides out polling errors while the server restarts, then returns the final state", async () => {
    const replies: Array<P2codeUpdateResult | Error> = [
      result({ phase: "building" }),
      result({ phase: "installing" }),
      new Error("socket closed"),
      new Error("socket closed"),
      result({ phase: "done", message: "Updated" }),
    ];
    const seen: Array<string> = [];
    const final = await watchP2codeUpdate({
      call: async () => {
        const reply = replies.shift();
        if (reply === undefined) throw new Error("polled past the end");
        if (reply instanceof Error) throw reply;
        return reply;
      },
      onProgress: (progress) => seen.push(progress.phase),
      signal: new AbortController().signal,
      wait: async () => undefined,
    });
    expect(final?.phase).toBe("done");
    expect(seen).toEqual(["building", "installing", "done"]);
  });

  it("keeps following the update through a fix thread and its resumed run", async () => {
    const replies = [
      result({ phase: "syncing" }),
      result({ phase: "conflict", threadId: "thread-1" }),
      result({ phase: "syncing" }),
      result({ phase: "installing" }),
      result({ phase: "done" }),
    ];
    const seen: Array<string> = [];
    const final = await watchP2codeUpdate({
      call: async () => replies.shift() ?? result({ phase: "failed" }),
      onProgress: (progress) => seen.push(progress.phase),
      signal: new AbortController().signal,
      wait: async () => undefined,
    });
    expect(final?.phase).toBe("done");
    expect(seen).toEqual(["syncing", "conflict", "syncing", "installing", "done"]);
  });

  it("returns null once aborted", async () => {
    const controller = new AbortController();
    const final = await watchP2codeUpdate({
      call: async () => {
        controller.abort();
        return result({ phase: "building" });
      },
      onProgress: () => undefined,
      signal: controller.signal,
      wait: async () => undefined,
    });
    expect(final).toBeNull();
  });
});

describe("attachP2codeUpdate", () => {
  it("attaches only to a running update and reports its terminal state", async () => {
    const replies = [result({ phase: "building" }), result({ phase: "done" })];
    const seen: string[] = [];
    const final = await attachP2codeUpdate({
      call: async () => replies.shift() ?? result({ phase: "failed" }),
      onProgress: (progress) => seen.push(progress.phase),
      signal: new AbortController().signal,
    });
    expect(final?.phase).toBe("done");
    expect(seen).toEqual(["building", "done"]);
  });
  it("returns a failure without watching", async () => {
    let calls = 0;
    const final = await attachP2codeUpdate({
      call: async () => {
        calls++;
        return result({ phase: "failed" });
      },
      onProgress: () => undefined,
      signal: new AbortController().signal,
    });
    expect(final?.phase).toBe("failed");
    expect(calls).toBe(1);
  });
});

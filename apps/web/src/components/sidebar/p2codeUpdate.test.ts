import { describe, expect, it } from "vite-plus/test";

import { resolveP2codeCheckOutcome } from "./p2codeUpdate";

const result = (overrides: Partial<Parameters<typeof resolveP2codeCheckOutcome>[0]>) => ({
  status: "available" as const,
  upstreamCommits: 0,
  localChanges: false,
  message: null,
  ...overrides,
});

describe("resolveP2codeCheckOutcome", () => {
  it("does nothing but report when p2code is up to date", () => {
    expect(resolveP2codeCheckOutcome(result({ status: "up-to-date" }))).toMatchObject({
      kind: "toast",
      type: "info",
      title: "p2code is up to date",
    });
  });

  it("asks before starting when upstream has new commits", () => {
    const outcome = resolveP2codeCheckOutcome(result({ upstreamCommits: 1 }));
    expect(outcome).toMatchObject({ kind: "confirm" });
    expect(outcome.kind === "confirm" && outcome.message).toContain("1 new upstream commit\n");
  });

  it("lists both upstream and local changes", () => {
    const outcome = resolveP2codeCheckOutcome(result({ upstreamCommits: 4, localChanges: true }));
    expect(outcome.kind === "confirm" && outcome.message).toContain("4 new upstream commits");
    expect(outcome.kind === "confirm" && outcome.message).toContain("changes made since");
  });

  it("explains uncommitted changes instead of starting", () => {
    expect(resolveP2codeCheckOutcome(result({ status: "dirty" }))).toMatchObject({
      kind: "toast",
      title: "Commit your p2code changes first",
    });
  });

  it("surfaces check errors", () => {
    expect(
      resolveP2codeCheckOutcome(result({ status: "error", message: "Could not reach upstream." })),
    ).toMatchObject({ kind: "toast", type: "error", description: "Could not reach upstream." });
  });
});

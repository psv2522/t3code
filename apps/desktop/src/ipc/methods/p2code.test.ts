import { describe, expect, it } from "vite-plus/test";

import { buildUpdateCommandFile, parseP2codeCheck, shellQuote } from "./p2code.ts";

describe("parseP2codeCheck", () => {
  it("reports up to date when nothing is pending", () => {
    expect(
      parseP2codeCheck('{"upstreamCommits":0,"localChanges":false,"dirty":false}\n'),
    ).toMatchObject({ status: "up-to-date", upstreamCommits: 0, localChanges: false });
  });

  it("reports an update for new upstream commits", () => {
    expect(
      parseP2codeCheck('{"upstreamCommits":3,"localChanges":false,"dirty":false}'),
    ).toMatchObject({ status: "available", upstreamCommits: 3 });
  });

  it("reports an update for local commits that were never installed", () => {
    expect(
      parseP2codeCheck('{"upstreamCommits":0,"localChanges":true,"dirty":false}'),
    ).toMatchObject({ status: "available", localChanges: true });
  });

  it("blocks on uncommitted changes even when updates are pending", () => {
    expect(parseP2codeCheck('{"upstreamCommits":2,"localChanges":true,"dirty":true}').status).toBe(
      "dirty",
    );
  });

  it("reads the last line so earlier output cannot break parsing", () => {
    expect(
      parseP2codeCheck('noise\n{"upstreamCommits":0,"localChanges":false,"dirty":false}\n').status,
    ).toBe("up-to-date");
  });

  it("returns an error for unreadable output", () => {
    expect(parseP2codeCheck("not json").status).toBe("error");
    expect(parseP2codeCheck('{"upstreamCommits":"1"}').status).toBe("error");
  });
});

describe("buildUpdateCommandFile", () => {
  it("quotes single quotes so odd paths cannot break out", () => {
    expect(shellQuote("/Users/o'neil/p2 code/update.sh")).toBe(
      "'/Users/o'\\''neil/p2 code/update.sh'",
    );
  });

  it("runs the update script in an interactive login zsh and keeps the window open", () => {
    const file = buildUpdateCommandFile("/repo/scripts/p2code-update.sh");
    expect(file.startsWith("#!/bin/zsh\nexec /bin/zsh -ilc ")).toBe(true);
    expect(file).toContain("/repo/scripts/p2code-update.sh");
    expect(file).toContain("Press any key to close");
  });
});

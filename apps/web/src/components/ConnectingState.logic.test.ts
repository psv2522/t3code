import { describe, expect, it } from "vite-plus/test";

import { resolveConnectingView } from "./ConnectingState.logic";

const environment = (
  label: string,
  phase: Parameters<typeof resolveConnectingView>[0][number]["connection"]["phase"],
  error: string | null = null,
) => ({ label, connection: { phase, error } });

describe("resolveConnectingView", () => {
  it("names the only environment still connecting", () => {
    expect(resolveConnectingView([environment("This computer", "connecting")])).toEqual({
      kind: "connecting",
      label: "This computer",
    });
  });

  it("drops the label when several environments are pending", () => {
    expect(
      resolveConnectingView([environment("A", "connecting"), environment("B", "reconnecting")]),
    ).toEqual({ kind: "connecting", label: null });
  });

  it("keeps waiting while any environment is pending even if another failed", () => {
    expect(
      resolveConnectingView([environment("A", "error", "boom"), environment("B", "connecting")]),
    ).toEqual({ kind: "connecting", label: "B" });
  });

  it("reports the failure once nothing is pending", () => {
    expect(
      resolveConnectingView([environment("A", "connected"), environment("B", "error", "refused")]),
    ).toEqual({ kind: "unreachable", label: "B", error: "refused" });
  });

  it("is ready when everything is connected or there are no environments", () => {
    expect(resolveConnectingView([environment("A", "connected")])).toEqual({ kind: "ready" });
    expect(resolveConnectingView([])).toEqual({ kind: "ready" });
  });
});

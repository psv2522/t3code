import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export type ConnectingView =
  | { readonly kind: "connecting"; readonly label: string | null }
  | { readonly kind: "unreachable"; readonly label: string; readonly error: string | null }
  | { readonly kind: "ready" };

export function resolveConnectingView(
  environments: ReadonlyArray<{
    readonly label: string;
    readonly connection: {
      readonly phase: EnvironmentConnectionPhase;
      readonly error: string | null;
    };
  }>,
): ConnectingView {
  const pending = environments.filter(
    ({ connection }) =>
      connection.phase === "available" ||
      connection.phase === "connecting" ||
      connection.phase === "reconnecting",
  );
  if (pending.length > 0) {
    return { kind: "connecting", label: pending.length === 1 ? pending[0]!.label : null };
  }
  const failed = environments.find(({ connection }) => connection.phase !== "connected");
  if (failed !== undefined) {
    return { kind: "unreachable", label: failed.label, error: failed.connection.error };
  }
  return { kind: "ready" };
}

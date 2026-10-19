import { expect, it } from "@effect/vitest";

import { isCloudConnectSession, isLanDeniedPath, isLanSource } from "./lanAccess.ts";

const requestFrom = (remoteAddress: string | undefined) =>
  ({ source: { socket: { remoteAddress } } }) as never;

it("treats only loopback peers as local", () => {
  expect(isLanSource(requestFrom("127.0.0.1"))).toBe(false);
  expect(isLanSource(requestFrom("::1"))).toBe(false);
  expect(isLanSource(requestFrom("::ffff:127.0.0.1"))).toBe(false);
  expect(isLanSource(requestFrom("192.168.1.23"))).toBe(true);
  expect(isLanSource(requestFrom("::ffff:172.20.10.2"))).toBe(true);
  expect(isLanSource(requestFrom("100.101.102.103"))).toBe(true);
});

it("fails closed when the peer address cannot be read", () => {
  expect(isLanSource(requestFrom(undefined))).toBe(true);
  expect(isLanSource({} as never)).toBe(true);
});

it("accepts only DPoP sessions minted for a T3 Connect link", () => {
  expect(isCloudConnectSession({ method: "dpop-access-token", subject: "cloud-connect" })).toBe(
    true,
  );
  expect(isCloudConnectSession({ method: "dpop-access-token", subject: "one-time-token" })).toBe(
    false,
  );
  expect(isCloudConnectSession({ method: "bearer-access-token", subject: "cloud-connect" })).toBe(
    false,
  );
  expect(isCloudConnectSession({ method: "browser-session-cookie", subject: "owner" })).toBe(false);
});

it("denies the routes that turn a secret into a session, however the path is spelled", () => {
  for (const url of [
    "/api/auth/browser-session",
    "/oauth/token",
    "/oauth/token/",
    "//oauth//token",
    "/OAuth/Token",
    "/oauth/token?x=1",
    "/oauth/mcp/approval",
    "/api/hooks/abc/def",
    "/api/connect/mint-credential",
    "/api/t3-connect/mint-credential",
    "/mcp",
    "/mcp/tools",
    "/.well-known/oauth-protected-resource",
  ]) {
    expect(isLanDeniedPath(url), url).toBe(true);
  }
});

it("keeps the routes a T3 Connect client uses open", () => {
  for (const url of [
    "/.well-known/t3/environment",
    "/api/auth/websocket-ticket",
    "/ws?wsTicket=abc",
    "/api/assets/signed/file.png",
    "/api/attachments/upload/token",
    "/",
  ]) {
    expect(isLanDeniedPath(url), url).toBe(false);
  }
});

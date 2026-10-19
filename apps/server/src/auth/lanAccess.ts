import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";

export const CLOUD_CONNECT_SUBJECT = "cloud-connect";

const DENIED_PATHS = new Set([
  "/api/auth/browser-session",
  "/oauth/token",
  "/api/connect/mint-credential",
  "/api/t3-connect/mint-credential",
  "/mcp",
]);

const DENIED_PREFIXES = ["/oauth/mcp/", "/api/hooks/", "/.well-known/oauth-", "/mcp/"];

const readRemoteAddress = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const source = request.source as
    | { readonly socket?: { readonly remoteAddress?: string | null } }
    | undefined;
  const address = source?.socket?.remoteAddress;
  if (typeof address !== "string" || address.length === 0) return undefined;
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
};

const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || address === "127.0.0.1" || address.startsWith("127.");

/**
 * Judged by the socket peer, never by `Host` or `X-Forwarded-*`, which a LAN
 * client controls. The Cloudflare tunnel and Tailscale Serve both dial
 * loopback. A request with no readable peer counts as remote.
 */
export const isLanSource = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const address = readRemoteAddress(request);
  return address === undefined || !isLoopbackAddress(address);
};

export const isCloudConnectSession = (session: {
  readonly method: string;
  readonly subject: string;
}): boolean => session.method === "dpop-access-token" && session.subject === CLOUD_CONNECT_SUBJECT;

export const isLanDeniedPath = (url: string): boolean => {
  const path = (url.split(/[?#]/, 1)[0] ?? "").replace(/\/{2,}/g, "/").toLowerCase();
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return DENIED_PATHS.has(trimmed) || DENIED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
};

export const layerGate = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      if (!config.lanConnectOnly) return yield* httpEffect;
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (isLanSource(request) && isLanDeniedPath(request.url)) {
        return HttpServerResponse.text("Forbidden", { status: 403 });
      }
      return yield* httpEffect;
    }),
  { global: true },
);

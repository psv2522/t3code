// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// createRequire loads the disk-backed SDK and adjacent chunks even from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);

/**
 * Loads the SDK on first call; `require` caches it after that. Loading it
 * costs the server about 20 MB of heap, so servers that never run Cursor
 * should never call this.
 */
export const loadCursorSdk = () => requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");

/** Loads the SDK's SQLite agent store, about 6 MB more heap, on the same terms. */
export const loadCursorSdkSqlite = () =>
  requireCursorSdk("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite");

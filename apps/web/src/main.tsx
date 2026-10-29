import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { MainBackgroundStartup } from "./mainBackground";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const ManagedAuthShell =
  clerkPublishableKey && hasCloudPublicConfig()
    ? React.lazy(() =>
        isElectron
          ? import("./components/clerk/ElectronManagedAuthShell")
          : import("./components/clerk/BrowserManagedAuthShell"),
      )
    : null;

export const startup = router
  .load()
  .then(() => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <MainBackgroundStartup />
        {ManagedAuthShell && clerkPublishableKey ? (
          <React.Suspense
            fallback={
              <main
                className="flex h-dvh items-center justify-center text-muted-foreground"
                role="status"
              >
                Loading workspace…
              </main>
            }
          >
            <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
          </React.Suspense>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });

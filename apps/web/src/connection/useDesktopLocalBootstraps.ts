import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useState } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps] = useState(readDesktopSecondaryBootstraps);
  return bootstraps;
}

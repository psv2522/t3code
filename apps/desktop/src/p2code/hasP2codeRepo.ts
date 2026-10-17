// @effect-diagnostics nodeBuiltinImport:off -- Reads the owner's local p2code home from the main process.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const hasP2codeRepo = async () => {
  try {
    const home = process.env.P2CODE_OUT ?? NodePath.join(NodeOS.homedir(), ".p2code");
    const repo = (await NodeFSP.readFile(NodePath.join(home, "repo"), "utf8")).trim();
    await NodeFSP.access(NodePath.join(repo, "scripts", "p2code-update.sh"));
    return true;
  } catch {
    return false;
  }
};

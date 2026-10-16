import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** True when the module at `importMetaUrl` is the script Node was started with. */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

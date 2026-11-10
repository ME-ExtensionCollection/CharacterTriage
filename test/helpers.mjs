// Load extension/src/core.js the way Marinara does (plain script, no modules).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadCore() {
  const code = readFileSync(join(ROOT, "extension/src/core.js"), "utf8");
  return vm.runInThisContext(`(() => {\n${code}\n;return CTR;\n})()`, { filename: "core.js" });
}

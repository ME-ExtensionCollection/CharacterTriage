// Build what Marinara would run, from extension/manifest.json:
//   - join the jsPath files with "\n\n" in order (Marinara's folder import does this)
//   - wrap them the way the server does for full page extensions
//     (fullPageExtensionSource in packages/server/src/routes/personal-extensions.routes.ts)
//   - compile the result, which catches syntax errors and duplicate top-level
//     names across files, since all files share one function scope
// Writes dev/build/page-runtime.js and dev/build/extension.css for the dev harness.
//
// Usage: node scripts/build.mjs [--check]   (--check compiles only, writes nothing)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");
const checkOnly = process.argv.includes("--check");

const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const config = manifest.config;
if (manifest.kind !== "marinara.personal-extension" || manifest.version !== 1) throw new Error("manifest.json: unexpected kind/version");
if (!config.capabilities?.includes("full_page_access")) throw new Error("manifest.json: full_page_access capability missing");

const paths = Array.isArray(config.jsPath) ? config.jsPath : [config.jsPath];
const js = paths.map((p) => readFileSync(join(EXT, p), "utf8")).join("\n\n");
const css = readFileSync(join(EXT, config.cssPath), "utf8");
if (Buffer.byteLength(css) > 256 * 1024) throw new Error("extension.css is over Marinara's 256 KiB limit");

const identity = JSON.stringify({ id: "dev-harness-triage", name: config.name, contentHash: "dev" });
const runtime = `(() => {
  "use strict";
  const extension = ${identity};
  const run = window.__marinaraRunFullPageExtension;
  if (typeof run !== "function") {
    throw new Error("Marinara full-page extension host is unavailable");
  }
  run(extension, async (marinara) => {
    "use strict";
${js}
  });
})();`;

new vm.Script(runtime, { filename: "page-runtime.js" }); // throws on SyntaxError
// The host wraps code in an async function, so `import`/`export` would fail there.
if (/^\s*(import|export)\s/m.test(js)) throw new Error("Extension code must not use import/export statements");

if (!checkOnly) {
  const out = join(ROOT, "dev/build");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "page-runtime.js"), runtime);
  writeFileSync(join(out, "extension.css"), css);
}
console.log(`${config.name} ${config.version}: ${paths.length} files, ${(js.length / 1024).toFixed(1)} KiB JS, ${(css.length / 1024).toFixed(1)} KiB CSS${checkOnly ? " (check only)" : " -> dev/build/"}`);

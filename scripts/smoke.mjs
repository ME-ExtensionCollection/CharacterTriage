// Browser smoke tests against the dev harness (mock Marinara + fake vision model).
//
// Needs `node scripts/serve.mjs` running, plus playwright-core and a Chromium:
//   CTR_PLAYWRIGHT=/path/to/node_modules/playwright-core   (default: import "playwright-core")
//   CTR_CHROME=/usr/bin/google-chrome-stable              (default: Playwright's own browser)
//   CTR_SHOTS=/some/dir                                   (optional screenshots)
// Usage: node scripts/smoke.mjs [baseUrl] [--only=name,name]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:5180";
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const env = (name) => process.env[`CTR_${name}`] ?? process.env[`CLM_${name}`];
const pw = await import(env("PLAYWRIGHT") ? pathToFileURL(join(env("PLAYWRIGHT"), "index.mjs")).href : "playwright-core");
const shots = env("SHOTS");
if (shots) mkdirSync(shots, { recursive: true });

const browser = await pw.chromium.launch({ executablePath: env("CHROME") || undefined, headless: true });
let failed = 0;
const stats = async () => (await fetch(`${BASE}/__mock/stats`)).json();

async function withPage(name, fn, { reset = "", query = "", allowErrors = null } = {}) {
  if (only && !only.includes(name)) return;
  await fetch(`${BASE}/__mock/reset${reset}`, { method: "POST" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !allowErrors?.test(m.text()) && errors.push(m.text()));
  const shot = async (label) => shots && page.screenshot({ path: join(shots, `${name}-${label}.png`) });
  try {
    await page.goto(`${BASE}/dev/harness.html${query}`);
    await page.waitForFunction(() => window.marinaraCharTriage);
    await page.evaluate(() => window.marinaraCharTriage.ready());
    await fn(page, shot);
    assert.deepEqual(errors, [], "page errors");
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
    await shot("failure");
  } finally {
    await context.close();
  }
}

const openPanel = async (page) => {
  await page.keyboard.press("Alt+Shift+KeyT");
  await page.waitForSelector(".ctr-panel");
};
const chooseConnection = async (page) => {
  await page.waitForSelector(".ctr-connection option[value='conn-vision']", { state: "attached" });
  await page.selectOption(".ctr-connection", "conn-vision");
};
/** Click Scan and wait for that run to finish. */
const scanAndWait = async (page, timeout = 60000) => {
  const before = await page.evaluate(() => window.marinaraCharTriage.scanState().finishedAt ?? 0);
  await page.click(".ctr-start");
  await page.waitForFunction((before) => {
    const s = window.marinaraCharTriage.scanState();
    return !s.running && (s.finishedAt ?? 0) > before;
  }, before, { timeout });
};
const waitScanned = (page, n, total = n, timeout = 30000) =>
  page.waitForFunction(([n, total]) => document.querySelector(".ctr-scan-status p")?.textContent.startsWith(`${n.toLocaleString()} of ${total.toLocaleString()} cards scanned`) && !document.querySelector(".ctr-stop"), [n, total], { timeout });
/** Make decisions through the API, like Character Library would. */
const decide = (page, rule) =>
  page.evaluate(async (rule) => {
    const t = window.marinaraCharTriage;
    const res = await fetch("/api/characters/catalog?view=summary").then((r) => r.json());
    const del = [];
    const keep = [];
    for (const c of res.items.slice(0, 120)) (eval(rule)(c) ? del : keep).push(c);
    await t.beforeDelete(del);
    await t.recordKeep(keep.map((c) => c.id));
    return { del: del.length, keep: keep.length };
  }, rule);

await withPage("scan-library", async (page, shot) => {
  await openPanel(page);
  // Not a chat model: the image-generation connection is not offered.
  assert.equal(await page.$(".ctr-connection option[value='conn-comfy']"), null);
  assert.equal(await page.isDisabled(".ctr-start"), true);
  await chooseConnection(page);
  await page.click(".ctr-start");
  await page.waitForSelector(".ctr-stop");
  await shot("running");
  await waitScanned(page, 300);
  const s = await stats();
  // 6 cards have no avatar (every 50th): scanned as "no avatar", no model call.
  // 3 are re-imports of the card before them: the scan is reused.
  assert.equal(s.raw, 291);
  assert.deepEqual(await page.evaluate(() => window.marinaraCharTriage.answers("card-00098")), await page.evaluate(() => window.marinaraCharTriage.answers("card-00097")));
  assert.equal(s.maxInFlight, 4);
  // No decisions and no profile: no scores yet.
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.scores().size), 0);
  assert.match(await page.textContent(".ctr-panel"), /Learning starts at 30 decisions/);
  // Scanning again does nothing new.
  await page.click(".ctr-start");
  await waitScanned(page, 300);
  assert.equal((await stats()).raw, 291);
});

await withPage("scan-resumes-after-reload", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  await page.click(".ctr-start");
  await page.waitForFunction(() => /this run: (\d+)/.exec(document.querySelector(".ctr-scan-status p")?.textContent ?? "")?.[1] >= 40);
  await page.reload();
  await page.waitForFunction(() => window.marinaraCharTriage);
  // Resumes on its own (after a short start-up delay).
  await openPanel(page);
  await waitScanned(page, 300, 300, 40000);
  const s = await stats();
  // Only what was in flight at the reload (up to 4, plus a re-import whose twin was among them) is asked twice.
  assert.ok(s.raw <= 291 + 8, `raw requests: ${s.raw}`);
}, { reset: "?delay=150" });

await withPage("scan-429-and-failures", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  await page.click(".ctr-start");
  await waitScanned(page, 300);
  const s = await stats();
  assert.ok(s.rateLimited > 0);
  assert.equal(await page.$(".ctr-error"), null);
}, { reset: "?rateLimit=40", allowErrors: /status of 429/ });

await withPage("scan-stops-when-model-down", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  await scanAndWait(page);
  await page.waitForSelector(".ctr-error");
  assert.match(await page.textContent(".ctr-error"), /model exploded/);
  assert.ok((await stats()).raw < 60, "should give up early");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("ctr-harness-storage")).settings.scanning === false);
}, { reset: "?fail=all&delay=5", allowErrors: /status of 500/ });

await withPage("learns-from-decisions", async (page, shot) => {
  await openPanel(page);
  await chooseConnection(page);
  await page.click(".ctr-start");
  await waitScanned(page, 300);
  // You delete every 3D render (every third card) and keep the rest.
  const made = await decide(page, "(c) => Number(c.id.slice(5)) % 3 === 0");
  assert.equal(made.del, 40);
  await page.waitForFunction(() => window.marinaraCharTriage.scores().size > 250, null, { timeout: 10000 });
  const { renders, others } = await page.evaluate(() => {
    const s = window.marinaraCharTriage.scores();
    const renders = [];
    const others = [];
    for (const [id, v] of s) {
      const n = Number(id.slice(5));
      // Skip cards with no avatar (every 50th) and the re-import pairs (97+98, …) that share one image and so one answer.
      if (n < 120 || n % 50 === 49 || n % 100 === 97 || n % 100 === 98) continue;
      (n % 3 === 0 ? renders : others).push([v, id]);
    }
    return { renders, others };
  });
  // Cards it never saw a decision on are ranked by the rule it learned.
  const low = renders.reduce((a, b) => (b[0] < a[0] ? b : a));
  const high = others.reduce((a, b) => (b[0] > a[0] ? b : a));
  assert.ok(low[0] > high[0], `lowest render ${low} vs highest other ${high}`);
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.bucketOf("card-00150")), 5);
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.decisionOf("card-00003")), "delete");
  await page.waitForFunction(() => /Predicts your call (9\d|100)%/.test(document.querySelector(".ctr-panel").textContent));
  assert.match(await page.textContent(".ctr-weights"), /style: 3d render/);
  // Tags: "3D" is on every render.
  await page.waitForSelector(".ctr-tag");
  assert.equal(await page.textContent(".ctr-tag .ctr-tag-name"), "3D");
  await shot("learned");
});

await withPage("pilot-scans-decided-cards", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  // 120 decisions on cards 0-119, none scanned yet.
  await decide(page, "(c) => Number(c.id.slice(5)) % 3 === 0");
  await page.click(".ctr-pilot");
  await page.waitForFunction(() => { const s = window.marinaraCharTriage.scanState(); return !s.running && s.finishedAt; }, null, { timeout: 60000 });
  const st = await page.evaluate(() => window.marinaraCharTriage.scanState());
  assert.equal(st.total, 120);
  assert.equal(st.pilot, true);
  // 2 of them have no avatar (49, 99), one is the re-import twin of 97.
  assert.equal((await stats()).raw, 117);
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.answers("card-00200")), null);
  await page.waitForFunction(() => /Predicts your call/.test(document.querySelector(".ctr-panel").textContent));
});

await withPage("learn-toggle-and-tags", async (page) => {
  await openPanel(page);
  // Deletes not about the image: logged for tags, left out of the model.
  await page.evaluate(async () => {
    const t = window.marinaraCharTriage;
    const res = await fetch("/api/characters/catalog?view=summary").then((r) => r.json());
    const cards = res.items.slice(0, 60);
    await t.beforeDelete(cards.slice(0, 20), { learnById: Object.fromEntries(cards.slice(0, 10).map((c) => [c.id, false])) });
    await t.recordKeep(cards.slice(20).map((c) => c.id));
    await t.recordKeep(cards.slice(0, 5).map((c) => c.id), { implied: true }); // already decided: ignored
  });
  const decisions = await page.evaluate(async () => {
    const db = await new Promise((r) => (indexedDB.open("char-triage").onsuccess = (e) => r(e.target.result)));
    return new Promise((r) => (db.transaction("decisions").objectStore("decisions").getAll().onsuccess = (e) => r(e.target.result)));
  });
  assert.equal(decisions.length, 60);
  assert.equal(decisions.filter((d) => d.decision === "delete" && d.learn === false).length, 10);
  assert.equal(decisions.filter((d) => d.decision === "delete" && d.learn === true).length, 10);
  // Unscanned deleted cards keep a small avatar to scan later.
  const kept = await page.evaluate(async () => {
    const db = await new Promise((r) => (indexedDB.open("char-triage").onsuccess = (e) => r(e.target.result)));
    return new Promise((r) => (db.transaction("avatars").objectStore("avatars").getAllKeys().onsuccess = (e) => r(e.target.result)));
  });
  assert.equal(kept.length, 20);
  // Turning the default off applies to later deletes.
  await page.uncheck(".ctr-learn");
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.learnFromDeletes()), false);
});

await withPage("blacklist-and-copy", async (page) => {
  await openPanel(page);
  await decide(page, "(c) => c.tags.includes('Horror')");
  await page.waitForSelector(".ctr-tag");
  assert.equal(await page.textContent(".ctr-tag .ctr-tag-name"), "Horror");
  await page.click(".ctr-tag .ctr-copy");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Horror");
  await page.click(".ctr-tag .ctr-blacklist");
  await page.waitForSelector(".ctr-tag .ctr-blacklist:has-text('On blacklist')");
  assert.deepEqual(await page.evaluate(() => window.__ciBlacklist), ["Horror"]);
}, { query: "?ci=1" });

await withPage("blacklist-needs-char-importer", async (page) => {
  await openPanel(page);
  await decide(page, "(c) => c.tags.includes('Horror')");
  await page.waitForSelector(".ctr-tag");
  assert.equal(await page.isDisabled(".ctr-tag .ctr-blacklist"), true);
});

await withPage("export-import", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  await page.click(".ctr-start");
  await waitScanned(page, 300);
  await decide(page, "(c) => Number(c.id.slice(5)) % 3 === 0");
  const download = page.waitForEvent("download");
  await page.click(".ctr-export");
  const file = await download;
  assert.match(file.suggestedFilename(), /^char-triage-backup-.*\.json$/);
  const path = await file.path();
  // Wipe this browser's data, reload, import the file.
  await page.evaluate(() => new Promise((r) => (indexedDB.deleteDatabase("char-triage").onsuccess = r)));
  await page.evaluate(() => localStorage.removeItem("ctr-harness-storage"));
  await page.reload();
  await page.waitForFunction(() => window.marinaraCharTriage);
  await page.evaluate(() => window.marinaraCharTriage.ready());
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.scores().size), 0);
  await openPanel(page);
  const chooser = page.waitForEvent("filechooser");
  await page.click(".ctr-import");
  await (await chooser).setFiles(path);
  await page.waitForSelector(".ctr-toast:has-text('120 decisions and 294 scans added')");
  await page.waitForFunction(() => window.marinaraCharTriage.scores().size > 250);
  await waitScanned(page, 294, 300);
  // Importing the same file again adds nothing.
  const again = page.waitForEvent("filechooser");
  await page.click(".ctr-import");
  await (await again).setFiles(path);
  await page.waitForSelector(".ctr-toast:has-text('0 decisions and 0 scans added')");
});

await withPage("deleted-card-still-scanned", async (page) => {
  await openPanel(page);
  // Delete a card before it was ever scanned, then scan.
  await page.evaluate(async () => {
    const res = await fetch("/api/characters/catalog?view=summary").then((r) => r.json());
    const card = res.items.find((c) => c.id === "card-00003");
    await window.marinaraCharTriage.beforeDelete([card]);
    await fetch("/api/characters/card-00003", { method: "DELETE", headers: { "x-marinara-csrf": "1" } });
  });
  await chooseConnection(page);
  await scanAndWait(page);
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.answers("card-00003")?.style), "3d_render");
});

await browser.close();
if (failed) {
  console.log(`${failed} smoke test(s) failed`);
  process.exit(1);
}
console.log("smoke ok");

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
/** Wait until `n` of `total` cards have every question asked (and no scan is running). */
const waitScanned = (page, n, total = n, timeout = 30000) =>
  page.waitForFunction(
    ([n, total]) => {
      const text = document.querySelector(".ctr-scan-status p")?.textContent ?? "";
      const want = n === total ? `All ${total.toLocaleString()} cards scanned` : `${n.toLocaleString()} of ${total.toLocaleString()} cards fully scanned`;
      return text.startsWith(want) && !document.querySelector(".ctr-stop");
    },
    [n, total],
    { timeout },
  );
/** Fields asked per request since the last reset: [{ card, fields }]. */
const asked = async () => (await stats()).asked;
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
  // Every request asked the built-in questions, tags included, nothing else.
  const fields = (await asked())[0].fields;
  assert.ok(fields.includes("tags") && fields.includes("style") && !fields.includes("caption") && !fields.includes("gore"));
  assert.ok((await asked()).every((a) => a.fields.length === fields.length));
  // Picture tags for the manager.
  const pic = await page.evaluate(() => window.marinaraCharTriage.imageTagsOf("card-00003"));
  for (const t of ["image:3d", "image:glossy_skin", "image:style:3d_render", "image:ai_artifacts:2"]) assert.ok(pic.includes(t), t);
  assert.ok(!(await page.evaluate(() => window.marinaraCharTriage.imageTagsOf("card-00001"))).includes("image:3d"));
  // No decisions and no profile: no scores yet.
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.scores().size), 0);
  assert.match(await page.textContent(".ctr-panel"), /Learning starts at 30 decisions/);
  // Esc closes the panel even though focus fell out of it during the scan.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ctr-panel", { state: "detached" });
  await openPanel(page);
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
  assert.deepEqual(await page.evaluate(() => window.__ciBlacklist), ["horror"]);
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
  // 294 scans plus the 6 cards with no avatar (recorded so they are not retried).
  await page.waitForSelector(".ctr-toast:has-text('120 decisions and 300 scans added')");
  await page.waitForFunction(() => window.marinaraCharTriage.scores().size > 250);
  await waitScanned(page, 300);
  // Importing the same file again adds nothing.
  const again = page.waitForEvent("filechooser");
  await page.click(".ctr-import");
  await (await again).setFiles(path);
  await page.waitForSelector(".ctr-toast:has-text('0 decisions and 0 scans added')");
});

await withPage("category-asks-only-new-question", async (page, shot) => {
  await openPanel(page);
  await chooseConnection(page);
  await scanAndWait(page);
  await waitScanned(page, 300);
  const before = (await asked()).length;
  // Turn on the Inflation example: every card now has one question to ask.
  await page.click(".ctr-preset[data-id='inflation']");
  await page.waitForSelector(".ctr-category[data-id='inflation']");
  await waitScanned(page, 6, 300); // only the 6 avatar-less cards count as done
  await shot("category");
  await scanAndWait(page);
  await waitScanned(page, 300);
  const added = (await asked()).slice(before);
  assert.equal(added.length, 291);
  assert.ok(added.every((a) => a.fields.length === 1 && a.fields[0] === "cat_inflation"), JSON.stringify(added[0]));
  // Picture tags: level 2 every 10th card, cumulative.
  const t10 = await page.evaluate(() => window.marinaraCharTriage.imageTagsOf("card-00010"));
  assert.ok(t10.includes("image:inflation") && t10.includes("image:inflation:2") && !t10.includes("image:inflation:3"));
  assert.ok(!(await page.evaluate(() => window.marinaraCharTriage.imageTagsOf("card-00011"))).includes("image:inflation"));
  assert.match(await page.textContent(".ctr-category[data-id='inflation'] .ctr-category-status"), /asked on every picture/);
  // Rewording it re-asks only it.
  await page.fill(".ctr-category[data-id='inflation'] .ctr-category-question", "balloon-like swollen bodies");
  await page.press(".ctr-category[data-id='inflation'] .ctr-category-question", "Enter");
  await page.locator(".ctr-panel h2").click();
  await waitScanned(page, 6, 300);
  // Turning it off: nothing to ask, and its picture tags go away.
  await page.uncheck(".ctr-category[data-id='inflation'] .ctr-category-on");
  await waitScanned(page, 300);
  assert.ok(!(await page.evaluate(() => window.marinaraCharTriage.imageTagsOf("card-00010"))).includes("image:inflation"));
  // A custom category.
  await page.fill(".ctr-new-label", "Vore");
  await page.fill(".ctr-new-question", "a character swallowed whole");
  await page.click(".ctr-add-category");
  await page.waitForSelector(".ctr-category[data-id='vore']");
  await waitScanned(page, 6, 300);
});

await withPage("profile-edit-asks-only-profile", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  await scanAndWait(page);
  const before = (await asked()).length;
  await page.fill(".ctr-profile", "no 3D renders");
  await page.locator(".ctr-panel h2").click();
  await waitScanned(page, 6, 300);
  await scanAndWait(page);
  const added = (await asked()).slice(before);
  assert.equal(added.length, 291);
  assert.ok(added.every((a) => a.fields.join() === "profile_match"));
  // Profile scores: renders 5 -> 1.0.
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.scoreOf("card-00003")), 1);
});

await withPage("scan-picked-cards", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  // Not scanned yet: ten picked cards get everything, nothing else is touched.
  const ids = Array.from({ length: 10 }, (_, i) => `card-${String(200 + i).padStart(5, "0")}`);
  assert.equal(await page.evaluate((ids) => window.marinaraCharTriage.scanCards(ids), ids), 10);
  await page.waitForFunction(() => { const s = window.marinaraCharTriage.scanState(); return !s.running && s.finishedAt; });
  assert.deepEqual((await asked()).map((a) => a.card).sort((a, b) => a - b), ids.map((id) => Number(id.slice(5))));
  // Already done: nothing to ask.
  assert.equal(await page.evaluate((ids) => window.marinaraCharTriage.scanCards(ids), ids), 0);
  // Picked cards join a running full scan and go next.
  await page.click(".ctr-start");
  await page.waitForFunction(() => window.marinaraCharTriage.scanState().running);
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.scanCards(["card-00001", "card-00002"])), 2);
  await page.waitForFunction(() => { const s = window.marinaraCharTriage.scanState(); return !s.running; }, null, { timeout: 30000 });
  const order = (await asked()).map((a) => a.card);
  assert.ok(order.indexOf(1) < 20 && order.indexOf(2) < 20, `picked cards scanned at ${order.indexOf(1)}, ${order.indexOf(2)}`);
  assert.equal(order.filter((n) => n === 1).length, 1, "not asked twice");
}, { reset: "?delay=40" });

await withPage("pause-implied-keeps", async (page) => {
  await openPanel(page);
  await page.check(".ctr-pause-implied");
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.recordKeep(["card-00001"], { implied: true })), 0);
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.recordKeep(["card-00001"])), 1, "explicit keeps still count");
  await page.uncheck(".ctr-pause-implied");
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.recordKeep(["card-00002"], { implied: true })), 1);
});

await withPage("storage-and-cleanup", async (page) => {
  await openPanel(page);
  await chooseConnection(page);
  await scanAndWait(page);
  // Two cards deleted outside Char Triage (no decision), one deleted with a decision.
  await page.evaluate(async () => {
    const res = await fetch("/api/characters/catalog?view=summary").then((r) => r.json());
    await window.marinaraCharTriage.beforeDelete([res.items.find((c) => c.id === "card-00005")]);
    for (const id of ["card-00004", "card-00005", "card-00007"]) await fetch(`/api/characters/${id}`, { method: "DELETE", headers: { "x-marinara-csrf": "1" } });
  });
  await page.waitForSelector(".ctr-cleanup");
  await page.click(".ctr-cleanup");
  await page.waitForSelector(".ctr-toast:has-text('Removed 2 scans')");
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.answers("card-00004")), null);
  assert.ok(await page.evaluate(() => window.marinaraCharTriage.answers("card-00005")), "decision keeps its scan");
  await page.waitForFunction(() => /298 scans, 1 decisions/.test(document.querySelector(".ctr-panel").textContent));
  // Clear everything needs the typed word.
  await page.click(".ctr-clear");
  await page.click(".ctr-clear-confirm");
  assert.ok(await page.evaluate(() => window.marinaraCharTriage.answers("card-00001")), "not cleared without CLEAR");
  await page.fill(".ctr-clear-typed", "CLEAR");
  await page.click(".ctr-clear-confirm");
  await page.waitForSelector(".ctr-toast:has-text('Cleared')");
  assert.equal(await page.evaluate(() => window.marinaraCharTriage.answers("card-00001")), null);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCore } from "./helpers.mjs";

const CTR = loadCore();

const answers = (over = {}) => ({
  style: "anime", ai_artifacts: 0, image_quality: 3, low_effort: false, text_overlay: "none", nsfw: 0, gore: 0,
  framing: "portrait", subjects: "one", presentation: "female", species: "human", background: "simple",
  palette: "bright", tone: "neutral", caption: "A girl with silver hair holding a sword", ...over,
});

test("schema has every question, profile_match only with a profile", () => {
  const plain = CTR.answerSchema("");
  assert.deepEqual(plain.required, Object.keys(CTR.QUESTIONS));
  assert.equal(plain.properties.profile_match, undefined);
  const withProfile = CTR.answerSchema("no 3D renders");
  assert.ok(withProfile.required.includes("profile_match"));
  assert.match(CTR.prompt("no 3D renders"), /What the user dislikes:\nno 3D renders/);
  assert.doesNotMatch(CTR.prompt(""), /profile_match/);
});

test("scan version changes with the profile", () => {
  assert.equal(CTR.scanVersion(""), CTR.scanVersion("   "));
  assert.notEqual(CTR.scanVersion("a"), CTR.scanVersion("b"));
  assert.equal(CTR.scanVersion("a"), CTR.scanVersion(" a "));
});

test("parseAnswers: bare, fenced, chatter around, bad values to null", () => {
  assert.equal(CTR.parseAnswers(JSON.stringify(answers())).style, "anime");
  assert.equal(CTR.parseAnswers("```json\n" + JSON.stringify(answers({ nsfw: 2 })) + "\n```").nsfw, 2);
  const messy = CTR.parseAnswers(`Sure! {"style":"watercolor","nsfw":7,"low_effort":true,"caption":"  x  ","extra":1} done`);
  assert.equal(messy.style, null);
  assert.equal(messy.nsfw, null);
  assert.equal(messy.low_effort, true);
  assert.equal(messy.caption, "x");
  assert.equal("extra" in messy, false);
  assert.equal("profile_match" in messy, false);
  assert.equal(CTR.parseAnswers(`{"style":"photo","profile_match":4}`).profile_match, 4);
  assert.throws(() => CTR.parseAnswers("no idea"), /No JSON object/);
  assert.throws(() => CTR.parseAnswers("{nope}"), /not valid JSON/);
  assert.throws(() => CTR.parseAnswers(`{"foo":1}`), /none of the expected/);
});

test("features: one-hot enums, scaled numbers, caption words, tags, creator", () => {
  const x = CTR.features(answers({ profile_match: 5 }), { tags: ["Female", " Dark  Elf "], creator: "Kestrel" });
  assert.equal(x.get("style=anime"), 1);
  assert.equal(x.get("image_quality"), 1);
  assert.equal(x.get("low_effort"), 0);
  assert.equal(x.get("profile_match"), 1);
  assert.equal(x.get("w:silver"), 0.5);
  assert.equal(x.has("w:with"), false);
  assert.equal(x.get("t:dark elf"), 1);
  assert.equal(x.get("c:kestrel"), 1);
  assert.equal(CTR.features(null, {}).get("unscanned"), 1);
  assert.equal(CTR.features(answers(), { tags: ["x"] }, { imageOnly: true }).has("t:x"), false);
});

test("logistic regression learns a separable rule and generalises", () => {
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    const render = i % 2 === 0;
    rows.push({ x: CTR.features(answers({ style: render ? "3d_render" : "anime", nsfw: i % 4 }), {}), y: render ? 1 : 0 });
  }
  const model = CTR.train(rows);
  assert.ok(CTR.predict(model, CTR.features(answers({ style: "3d_render" }))) > 0.8);
  assert.ok(CTR.predict(model, CTR.features(answers({ style: "anime" }))) < 0.2);
  assert.ok(CTR.crossValidate(rows) > 0.95);
  assert.equal(CTR.topWeights(model).dislike[0][0], "style=3d_render");
  assert.equal(CTR.crossValidate(rows.slice(0, 5)), null);
});

test("training rows: newest decision per card, learn=false deletes skipped, implied keeps light", () => {
  const decisions = [
    { cardId: "a", decision: "keep", at: "2026-01-01", tags: [] },
    { cardId: "a", decision: "delete", at: "2026-01-02", learn: true, tags: [] },
    { cardId: "b", decision: "delete", at: "2026-01-01", learn: false, tags: [] },
    { cardId: "c", decision: "implied-keep", at: "2026-01-01", tags: [] },
  ];
  const rows = CTR.trainingRows(decisions, (id) => (id === "a" ? answers() : null));
  assert.deepEqual(rows.map((r) => [r.cardId, r.y, r.w]), [["a", 1, 1], ["c", 0, CTR.IMPLIED_WEIGHT]]);
  assert.equal(rows[0].x.get("style=anime"), 1);
  assert.equal(rows[1].x.get("unscanned"), 1);
});

test("disliked tags: smoothed, needs support, ranks by strength", () => {
  const decisions = [];
  let n = 0;
  const add = (decision, tags, extra = {}) => decisions.push({ cardId: `id${n++}`, decision, at: "2026-01-01", tags, ...extra });
  for (let i = 0; i < 30; i += 1) add("delete", ["3D", "Female"]);
  for (let i = 0; i < 3; i += 1) add("delete", ["Rare"]);
  for (let i = 0; i < 6; i += 1) add("delete", ["Elf"], { learn: false });
  for (let i = 0; i < 40; i += 1) add("keep", ["Female", "Anime"]);
  for (let i = 0; i < 2; i += 1) add("keep", ["3D"]);
  const list = CTR.dislikedTags(decisions);
  // 30 of 32 outranks 6 of 6: smoothing wants evidence.
  assert.deepEqual(list.map((t) => t.tag), ["3D", "Elf"]);
  assert.ok(!list.some((t) => t.tag === "Rare"), "below support");
  assert.ok(!list.some((t) => t.tag === "Female"), "kept more than deleted");
  assert.ok(!CTR.dislikedTags(decisions, { learnOnly: true }).some((t) => t.tag === "Elf"));
  assert.deepEqual(CTR.dislikedTags([{ cardId: "x", decision: "delete", at: "1", tags: ["a"] }]), []);
});

test("backup merge: decision log union, newer scan wins", () => {
  const current = {
    decisions: [{ cardId: "a", at: "1", decision: "keep" }],
    scans: [{ cardId: "a", scannedAt: "2026-02-01", answers: { style: "anime" } }],
  };
  const backup = CTR.makeBackup({
    settings: {},
    decisions: [{ cardId: "a", at: "1", decision: "keep" }, { cardId: "b", at: "2", decision: "delete" }, { bogus: true }],
    scans: [{ cardId: "a", scannedAt: "2026-01-01", answers: { style: "photo" } }, { cardId: "b", scannedAt: "2026-01-01", answers: { style: "photo" } }],
  });
  const merged = CTR.mergeBackup(current, JSON.parse(JSON.stringify(backup)));
  assert.equal(merged.addedDecisions, 1);
  assert.equal(merged.decisions.length, 2);
  assert.equal(merged.addedScans, 1);
  assert.equal(merged.scans.find((s) => s.cardId === "a").answers.style, "anime");
  assert.throws(() => CTR.mergeBackup(current, { kind: "other" }), /Not a Char Triage backup/);
});

test("buckets", () => {
  assert.deepEqual([0, 0.19, 0.2, 0.5, 0.99, 1].map(CTR.bucket), [1, 1, 2, 3, 5, 5]);
  assert.equal(CTR.bucket(null), null);
});

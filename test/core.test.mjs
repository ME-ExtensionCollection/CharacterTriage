import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCore } from "./helpers.mjs";

const CTR = loadCore();

const answers = (over = {}) => ({
  style: "anime", ai_artifacts: 0, image_quality: 3, low_effort: false, text_overlay: "none", nsfw: 0,
  framing: "portrait", subjects: "one", presentation: "female", species: "human", background: "simple",
  palette: "bright", tone: "neutral", tags: ["1girl", "silver_hair", "sword"], ...over,
});
const inflation = { id: "inflation", label: "Inflation", question: "body inflation", enabled: true };
const vore = { id: "vore", label: "Vore", question: "vore", enabled: false };
const ids = (qs) => qs.map((q) => q.id);

test("active questions: built in, enabled categories, profile", () => {
  const base = CTR.activeQuestions();
  assert.equal(base.at(-1).id, "tags");
  assert.ok(!ids(base).includes("caption") && !ids(base).includes("gore"));
  const all = CTR.activeQuestions({ categories: [inflation, vore], profile: "no vore" });
  assert.deepEqual(ids(all).slice(-2), ["cat_inflation", "profile_match"]);
  assert.equal(all.at(-2).rubric, "body inflation. 0: not shown at all. 1: a little, or possibly. 2: clearly shown. 3: it is the point of the picture. When unsure, 0.");
  const hyper = CTR.CATEGORY_PRESETS.find((p) => p.id === "hyper_anatomy");
  assert.match(CTR.categoryRubric(hyper), /\. 0: normal human proportions, including large breasts/);
  assert.match(CTR.categoryRubric(hyper), /1: a little past realistic \(large alone is not enough\)\. 2: clearly impossible size\./);
  assert.doesNotMatch(CTR.categoryRubric(hyper), /or possibly/);
  // Own levels are part of the question.
  assert.notEqual(CTR.questionKey(CTR.categoryQuestion(inflation)), CTR.questionKey(CTR.categoryQuestion({ ...inflation, levels: "1: x. 2: y. 3: z." })));
  // Changing what counts as 0 is a change to the question.
  assert.notEqual(CTR.questionKey(CTR.categoryQuestion({ ...inflation })), CTR.questionKey(CTR.categoryQuestion({ ...inflation, zero: "pregnancy" })));
});

test("presets have unique slug ids", () => {
  const list = CTR.CATEGORY_PRESETS.map((p) => p.id);
  assert.equal(new Set(list).size, list.length);
  for (const p of CTR.CATEGORY_PRESETS) assert.equal(CTR.slug(p.id), p.id);
  assert.equal(CTR.slug("  Weight Gain / Feeding! "), "weight_gain_feeding");
});

test("question keys: only the changed question goes stale", () => {
  const before = CTR.activeQuestions({ categories: [inflation], profile: "a" });
  let scan = CTR.mergeAnswers(null, { cardId: "x", avatarPath: "/a.png", questions: before, answers: { ...answers(), cat_inflation: 2, profile_match: 3 } });
  assert.deepEqual(CTR.missingQuestions(scan, before, "/a.png"), []);
  // New category: only it.
  const withVore = CTR.activeQuestions({ categories: [inflation, { ...vore, enabled: true }], profile: "a" });
  assert.deepEqual(ids(CTR.missingQuestions(scan, withVore, "/a.png")), ["cat_vore"]);
  // Profile edited: only profile_match.
  assert.deepEqual(ids(CTR.missingQuestions(scan, CTR.activeQuestions({ categories: [inflation], profile: "b" }), "/a.png")), ["profile_match"]);
  // Category reworded: only it.
  const reworded = CTR.activeQuestions({ categories: [{ ...inflation, question: "balloon-like bodies" }], profile: "a" });
  assert.deepEqual(ids(CTR.missingQuestions(scan, reworded, "/a.png")), ["cat_inflation"]);
  // Category removed: nothing to ask.
  assert.deepEqual(CTR.missingQuestions(scan, CTR.activeQuestions({ profile: "a" }), "/a.png"), []);
  // New avatar file: everything.
  assert.equal(CTR.missingQuestions(scan, before, "/b.png").length, before.length);
  // Never scanned: everything.
  assert.equal(CTR.missingQuestions(undefined, before, "/a.png").length, before.length);
  // No avatar: nothing until it has one.
  const none = { cardId: "y", noAvatar: true, avatarPath: null, asked: {} };
  assert.deepEqual(CTR.missingQuestions(none, before, ""), []);
  assert.equal(CTR.missingQuestions(none, before, "/new.png").length, before.length);
  // Merging keeps older answers and only replaces what was asked.
  scan = CTR.mergeAnswers(scan, { cardId: "x", avatarPath: "/a.png", questions: [withVore.at(-2)], answers: { cat_vore: 1 } });
  assert.equal(scan.answers.cat_inflation, 2);
  assert.equal(scan.answers.cat_vore, 1);
  assert.deepEqual(CTR.missingQuestions(scan, withVore, "/a.png"), []);
});

test("schema and prompt cover just the questions asked", () => {
  const qs = CTR.activeQuestions({ categories: [inflation], profile: "no inflation" }).filter((q) => q.id === "cat_inflation" || q.id === "profile_match");
  const schema = CTR.answerSchema(qs);
  assert.deepEqual(schema.required, ["cat_inflation", "profile_match"]);
  const text = CTR.prompt(qs);
  assert.match(text, /- cat_inflation: body inflation/);
  assert.match(text, /What the user dislikes:\nno inflation/);
  assert.doesNotMatch(text, /- style:/);
  assert.doesNotMatch(CTR.prompt(qs.slice(0, 1)), /What the user dislikes/);
  assert.equal(CTR.answerSchema(CTR.activeQuestions()).properties.tags.type, "array");
});

test("parseAnswers: fenced, chatter, bad values to null, tags normalised", () => {
  const qs = CTR.activeQuestions({ categories: [inflation] });
  const got = CTR.parseAnswers("```json\n" + JSON.stringify(answers({ nsfw: 2, cat_inflation: 3, tags: ["Long Hair", "#maid", "long_hair", "  ", "x".repeat(60)] })) + "\n```", qs);
  assert.equal(got.nsfw, 2);
  assert.equal(got.cat_inflation, 3);
  assert.deepEqual(got.tags, ["long_hair", "maid", "x".repeat(40)]);
  const messy = CTR.parseAnswers(`Sure! {"style":"watercolor","nsfw":7,"low_effort":true,"tags":"nope","extra":1}`, qs);
  assert.equal(messy.style, null);
  assert.equal(messy.nsfw, null);
  assert.equal(messy.low_effort, true);
  assert.equal(messy.tags, null);
  assert.equal("extra" in messy, false);
  // No cap on tags; only a runaway guard, and hitting it is recorded.
  const many = CTR.parseAnswers(JSON.stringify({ tags: Array.from({ length: 40 }, (_, i) => `t${i}`) }), qs);
  assert.equal(many.tags.length, 40);
  assert.equal("tagsTruncated" in many, false);
  const runaway = CTR.parseAnswers(JSON.stringify({ tags: Array.from({ length: 500 }, (_, i) => `t${i}`) }), qs);
  assert.equal(runaway.tags.length, CTR.TAG_GUARD);
  assert.equal(runaway.tagsTruncated, true);
  const tagQ = qs.filter((q) => q.id === "tags");
  const marked = CTR.mergeAnswers(null, { cardId: "r", avatarPath: "/r.png", questions: tagQ, answers: runaway });
  assert.equal(marked.answers.tagsTruncated, true);
  assert.equal("tagsTruncated" in CTR.mergeAnswers(marked, { cardId: "r", avatarPath: "/r.png", questions: tagQ, answers: many }).answers, false);
  // The guard is in the schema, so the model is stopped there while generating.
  assert.equal(CTR.answerSchema(qs).properties.tags.maxItems, CTR.TAG_GUARD);
  assert.throws(() => CTR.parseAnswers("no idea", qs), /No JSON object/);
  assert.throws(() => CTR.parseAnswers("{nope}", qs), /not valid JSON/);
  assert.throws(() => CTR.parseAnswers(`{"foo":1}`, qs), /none of the expected/);
});

test("picture tags: free tags, fields, cumulative levels, enabled categories only", () => {
  const tags = CTR.imageTags(answers({ nsfw: 2, low_effort: true, cat_inflation: 2, cat_vore: 3 }), { categories: [inflation, vore] });
  for (const t of ["image:1girl", "image:sword", "image:style:anime", "image:nsfw", "image:nsfw:1", "image:nsfw:2", "image:low_effort", "image:inflation", "image:inflation:1", "image:inflation:2", "image:image_quality:3"]) {
    assert.ok(tags.includes(t), t);
  }
  for (const t of ["image:nsfw:3", "image:inflation:3", "image:vore", "image:ai_artifacts"]) assert.ok(!tags.includes(t), t);
  assert.deepEqual(CTR.imageTags(null), []);
});

test("migrating 0.1 scans keeps their answers and only adds the new questions", () => {
  const old = { cardId: "a", version: `1:${CTR.hash32("no 3d")}`, avatarHash: "h", answers: { ...answers(), tags: undefined, caption: "a girl", gore: 0, profile_match: 4 }, scannedAt: "2026-01-01" };
  delete old.answers.tags;
  const scan = CTR.migrateScan(old, "no 3d", "/a.png");
  assert.equal(scan.avatarPath, "/a.png");
  const qs = CTR.activeQuestions({ categories: [inflation], profile: "no 3d" });
  assert.deepEqual(ids(CTR.missingQuestions(scan, qs, "/a.png")), ["tags", "cat_inflation"]);
  // A different profile: profile_match too.
  const other = CTR.migrateScan(old, "something else", "/a.png");
  assert.deepEqual(ids(CTR.missingQuestions(other, CTR.activeQuestions({ profile: "something else" }), "/a.png")), ["tags", "profile_match"]);
  // No-avatar 0.1 scans.
  const none = CTR.migrateScan({ cardId: "b", version: "1:-", answers: null }, "", "");
  assert.equal(none.noAvatar, true);
  // Already migrated: untouched.
  assert.equal(CTR.migrateScan(scan, "no 3d", "/a.png"), scan);
});

test("features: one-hot, scaled numbers, picture tags, categories in use, tags, creator", () => {
  const x = CTR.features(answers({ profile_match: 5, cat_inflation: 3, cat_vore: 3 }), { tags: ["Female", " Dark  Elf "], creator: "Kestrel" }, { categories: [inflation, vore] });
  assert.equal(x.get("style=anime"), 1);
  assert.equal(x.get("image_quality"), 1);
  assert.equal(x.get("low_effort"), 0);
  assert.equal(x.get("profile_match"), 1);
  assert.equal(x.get("it:silver_hair"), 0.5);
  assert.equal(x.get("cat_inflation"), 1);
  assert.equal(x.has("cat_vore"), false, "disabled category ignored");
  assert.equal(x.get("t:dark elf"), 1);
  assert.equal(x.get("c:kestrel"), 1);
  assert.equal(CTR.features(null, {}).get("unscanned"), 1);
  assert.equal(CTR.features(answers(), { tags: ["x"] }, { imageOnly: true }).has("t:x"), false);
  // 0.1 scans with a caption and no tags still give words.
  assert.equal(CTR.features({ ...answers(), tags: undefined, caption: "glossy render" }).get("w:glossy"), 0.5);
});

test("logistic regression learns a separable rule and generalises", () => {
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    const bad = i % 2 === 0;
    rows.push({ x: CTR.features(answers({ cat_inflation: bad ? 2 + (i % 4 === 0 ? 1 : 0) : 0, nsfw: i % 4 }), {}), y: bad ? 1 : 0 });
  }
  const model = CTR.train(rows);
  assert.ok(CTR.predict(model, CTR.features(answers({ cat_inflation: 3 }))) > 0.8);
  assert.ok(CTR.predict(model, CTR.features(answers({ cat_inflation: 0 }))) < 0.2);
  assert.ok(CTR.crossValidate(rows) > 0.95);
  assert.equal(CTR.topWeights(model).dislike[0][0], "cat_inflation");
  assert.equal(CTR.crossValidate(rows.slice(0, 5)), null);
});

test("training rows: newest decision per card, learn=false deletes skipped, implied keeps light, current scan preferred", () => {
  const decisions = [
    { cardId: "a", decision: "keep", at: "2026-01-01", tags: [] },
    { cardId: "a", decision: "delete", at: "2026-01-02", learn: true, tags: [], answers: { style: "photo" } },
    { cardId: "b", decision: "delete", at: "2026-01-01", learn: false, tags: [] },
    { cardId: "c", decision: "implied-keep", at: "2026-01-01", tags: [] },
  ];
  const rows = CTR.trainingRows(decisions, (id) => (id === "a" ? answers() : null));
  assert.deepEqual(rows.map((r) => [r.cardId, r.y, r.w]), [["a", 1, 1], ["c", 0, CTR.IMPLIED_WEIGHT]]);
  assert.equal(rows[0].x.get("style=anime"), 1, "the scan (with later questions) beats the snapshot");
  assert.equal(rows[1].x.get("unscanned"), 1);
});

test("disliked tags: smoothed, needs support, ranks by strength; picture tags too", () => {
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
  assert.ok(!CTR.dislikedTags(decisions, { learnOnly: true }).some((t) => t.tag === "Elf"));
  assert.deepEqual(CTR.dislikedTags([{ cardId: "x", decision: "delete", at: "1", tags: ["a"] }]), []);
  // Same statistics over picture tags.
  const pic = CTR.dislikedTags(decisions, { tagsOf: (d) => (d.decision === "delete" && d.tags.includes("3D") ? ["render"] : ["clean"]), keyOf: (t) => t });
  assert.deepEqual(pic.map((t) => t.tag), ["render"]);
});

test("backup merge: decision log union, scans merged per question", () => {
  const q = CTR.activeQuestions({ categories: [inflation] });
  const scanA = CTR.mergeAnswers(null, { cardId: "a", avatarPath: "/a.png", questions: q.slice(0, -1), answers: answers(), at: "2026-02-01" });
  const scanA2 = CTR.mergeAnswers(null, { cardId: "a", avatarPath: "/a.png", questions: q.slice(-1), answers: { cat_inflation: 2 }, at: "2026-03-01" });
  const current = { decisions: [{ cardId: "a", at: "1", decision: "keep" }], scans: [scanA] };
  const backup = CTR.makeBackup({
    settings: {},
    decisions: [{ cardId: "a", at: "1", decision: "keep" }, { cardId: "b", at: "2", decision: "delete" }, { bogus: true }],
    scans: [scanA2, { cardId: "b", scannedAt: "2026-01-01", avatarPath: null, noAvatar: true, asked: {}, answers: null }],
  });
  const merged = CTR.mergeBackup(current, JSON.parse(JSON.stringify(backup)));
  assert.equal(merged.addedDecisions, 1);
  assert.equal(merged.decisions.length, 2);
  assert.equal(merged.addedScans, 2);
  const a = merged.scans.find((s) => s.cardId === "a");
  assert.equal(a.answers.style, "anime");
  assert.equal(a.answers.cat_inflation, 2);
  assert.deepEqual(CTR.missingQuestions(a, q, "/a.png"), []);
  // Same file again: nothing new.
  assert.equal(CTR.mergeBackup({ decisions: merged.decisions, scans: merged.scans }, backup).addedScans, 0);
  assert.throws(() => CTR.mergeBackup(current, { kind: "other" }), /Not a Char Triage backup/);
});

test("buckets", () => {
  assert.deepEqual([0, 0.19, 0.2, 0.5, 0.99, 1].map(CTR.bucket), [1, 1, 2, 3, 5, 5]);
  assert.equal(CTR.bucket(null), null);
});

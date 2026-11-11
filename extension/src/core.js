// Char Triage: pure logic, no DOM or network. The questions the vision model
// is asked (built in, your own categories, the dislike profile), each with its
// own version key so a change only re-asks that one question; the prompt and
// JSON schema for whichever questions a card still needs; parsing the reply;
// picture tags for the Character Manager; features and a small logistic
// regression trained on your decisions; tag statistics and backup merging.
// Unit-tested in test/core.test.mjs.

const CTR = (() => {
  "use strict";

  // ── Questions ──

  /**
   * Built-in questions, in prompt order: { id, schema, rubric }. Changing a
   * rubric or schema changes that question's key, so it is asked again (and
   * only it). The wording of the ones from 0.1 is unchanged on purpose.
   */
  const BUILTIN = Object.freeze([
    {
      id: "style",
      schema: { enum: ["anime", "semi_realistic", "3d_render", "photo", "painterly", "sketch", "pixel", "other"] },
      rubric: "art style: anime (anime/manga/cel-shaded), semi_realistic, 3d_render (CGI, game/Daz/Koikatsu renders), photo (real photograph), painterly (digital or traditional painting), sketch (line art, unfinished), pixel, other",
    },
    {
      id: "ai_artifacts",
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: "signs of AI generation: 0 none visible, 1 subtle (too-smooth skin, generic glossy look), 2 obvious (malformed hands, eyes or fingers, melted details, garbled background objects), 3 severe (badly broken anatomy or faces)",
    },
    {
      id: "image_quality",
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: "technical quality: 0 very poor (tiny, blurry, heavily compressed, cropped badly), 1 poor, 2 decent, 3 high (crisp, clean, well composed)",
    },
    {
      id: "low_effort",
      schema: { type: "boolean" },
      rubric: "true if the image is a screenshot, meme, plain text, logo, placeholder, collage or otherwise not a proper character picture",
    },
    {
      id: "text_overlay",
      schema: { enum: ["none", "small", "prominent"] },
      rubric: "text, captions, logos or watermarks drawn on the image: none, small (corner signature or watermark), prominent (titles, big captions, text covering the picture)",
    },
    {
      id: "nsfw",
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: "sexual content: 0 safe, 1 suggestive (revealing clothes, pin-up pose), 2 partial nudity, 3 explicit",
    },
    {
      id: "framing",
      schema: { enum: ["face", "portrait", "full_body", "scene", "no_character"] },
      rubric: "framing of the main character: face (head only), portrait (head and torso), full_body, scene (characters small in a wider scene), no_character",
    },
    { id: "subjects", schema: { enum: ["none", "one", "two", "group"] }, rubric: "how many characters are shown" },
    { id: "presentation", schema: { enum: ["female", "male", "mixed", "ambiguous", "none"] }, rubric: "gender presentation of the character(s) shown" },
    {
      id: "species",
      schema: { enum: ["human", "humanlike", "furry", "monster", "robot", "object", "none"] },
      rubric: "what the main character is: human, humanlike (elf, demon, kemonomimi with animal ears/tail), furry (anthro animal), monster, robot, object (no living character), none",
    },
    { id: "background", schema: { enum: ["plain", "simple", "detailed"] }, rubric: "background: plain (flat colour or transparent), simple, detailed" },
    { id: "palette", schema: { enum: ["dark", "bright", "pastel", "muted", "monochrome", "neon"] }, rubric: "overall colours" },
    { id: "tone", schema: { enum: ["wholesome", "neutral", "romantic", "sexual", "dark", "comedic"] }, rubric: "overall mood of the image" },
    {
      id: "tags",
      // maxItems is a runaway guard, not a cap: llama.cpp enforces the schema while
      // generating, so a looping reply stops at the guard instead of running into the
      // token limit as broken JSON (seen on a real card). Real cards use 12-24.
      schema: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 60 },
      rubric: "every danbooru-style tag that fits what is visible (lowercase, underscores instead of spaces, e.g. 1girl, long_hair, maid, sword, tentacles, large_breasts, outdoors): characters, body, clothing, objects, setting, art. As many as apply, most important first. Only what you can see.",
    },
  ]);
  // Not a limit on what the model may say: a guard against a reply that loops
  // forever. A scan that reaches it is marked (tagsTruncated) so it is visible.
  const TAG_GUARD = 60;

  // Levels shared by every category. Tested on real cards: without a concrete
  // "what counts as 0" and "when unsure, 0", the model rates ordinary images 1-2.
  const CATEGORY_LEVELS = "1: a little, or possibly. 2: clearly shown. 3: it is the point of the picture. When unsure, 0.";
  const CATEGORY_ZERO = "not shown at all";

  /**
   * Example categories, off until you turn them on (and editable). `question`
   * is what to look for, `zero` what does NOT count (the line the model needs
   * most). Worded against real cards with Qwen 3.6.
   */
  const CATEGORY_PRESETS = Object.freeze([
    {
      id: "hyper_anatomy",
      label: "Hyper anatomy",
      question: "body parts drawn far larger than humanly possible (breasts bigger than the head, a belly like a beach ball, thighs wider than a doorway)",
      zero: "normal human proportions, including large breasts and curvy, chubby or muscular bodies a real person could have",
    },
    { id: "inflation", label: "Inflation", question: "a body or belly swollen up like a balloon (with air, liquid or similar), round and taut", zero: "normal bellies, pregnancy, chubby or fat bodies" },
    { id: "weight_gain", label: "Weight gain", question: "weight gain or extreme obesity as the theme (stuffing, feeding, a body far heavier than average)", zero: "slim, average, curvy, thick or chubby bodies" },
    {
      id: "body_horror",
      label: "Body horror",
      question: "body horror or extreme distortion: mutated, melting, twisted, stretched or merged bodies",
      zero: "intact bodies, including monsters, demons and fantasy races drawn as whole creatures, makeup or costumes",
    },
    { id: "gore_guro", label: "Gore / guro", question: "gore or guro: blood, open wounds, exposed organs, mutilation", zero: "no injuries; weapons, bandages, eyepatches or a small scratch alone" },
    { id: "amputation", label: "Dismemberment / amputation", question: "dismemberment or amputation: missing or severed limbs, stumps", zero: "all limbs present; a wheelchair, crutches or bandages alone" },
    { id: "vore", label: "Vore", question: "vore: a character being swallowed or eaten whole, or visibly inside another's body or belly", zero: "eating food, kissing, open mouths, biting" },
  ]);

  /** A category label to its id: lowercase letters, digits, underscores. */
  const slug = (text) =>
    String(text ?? "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);

  const categoryField = (id) => `cat_${id}`;

  /** "<what to look for>. 0: <what does not count>. 1: … When unsure, 0." */
  function categoryRubric(category) {
    const what = String(category.question || category.label || category.id).trim().replace(/[.\s]+$/u, "");
    const zero = String(category.zero || CATEGORY_ZERO).trim().replace(/[.\s]+$/u, "");
    return `${what}. 0: ${zero}. ${CATEGORY_LEVELS}`;
  }

  function categoryQuestion(category) {
    return {
      id: categoryField(category.id),
      category: category.id,
      label: category.label,
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: categoryRubric(category),
    };
  }

  const hasProfile = (profile) => typeof profile === "string" && profile.trim().length > 0;

  function profileQuestion(profile) {
    return {
      id: "profile_match",
      schema: { type: "integer", minimum: 1, maximum: 5 },
      rubric: "how well this image matches what the user DISLIKES (described below): 1 not at all, 3 partly, 5 exactly what they dislike",
      profile: profile.trim().slice(0, 2000),
    };
  }

  /** Every question currently in use: built in, enabled categories, the profile. Each carries its `key`. */
  function activeQuestions({ categories = [], profile = "" } = {}) {
    const list = [...BUILTIN];
    for (const c of categories) if (c?.enabled && c.id) list.push(categoryQuestion(c));
    if (hasProfile(profile)) list.push(profileQuestion(profile));
    return list.map((q) => ({ ...q, key: questionKey(q) }));
  }

  function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** Version key of one question: changes when its wording, schema or (profile) text changes. */
  const questionKey = (q) => q.key ?? hash32(`${q.id}\n${q.rubric}\n${JSON.stringify(q.schema)}\n${q.profile ?? ""}`);

  /**
   * Questions a card still needs asked. A scan made for another avatar file
   * needs everything; a card with no avatar needs nothing until it gets one.
   */
  function missingQuestions(scan, questions, avatarPath) {
    if (scan && avatarPath !== undefined && (scan.avatarPath ?? null) !== (avatarPath || null)) return avatarPath ? questions : [];
    if (scan?.noAvatar) return [];
    return questions.filter((q) => scan?.asked?.[q.id] !== questionKey(q));
  }

  function answerSchema(questions) {
    const properties = {};
    for (const q of questions) properties[q.id] = q.schema;
    return { type: "object", additionalProperties: false, required: questions.map((q) => q.id), properties };
  }

  function prompt(questions) {
    const parts = [
      "You are labelling the avatar image of a roleplay character card. Look only at the image.",
      "Answer every field with a JSON object, nothing else. Judge what is visible; do not guess from style alone.",
      "",
      "Fields:",
      ...questions.map((q) => `- ${q.id}: ${q.rubric}`),
    ];
    const profile = questions.find((q) => q.profile)?.profile;
    if (profile) parts.push("", "What the user dislikes:", profile);
    return parts.join("\n");
  }

  // ── Parsing ──

  /** One picture tag: lowercase, underscores, no leading #, at most 40 characters. */
  function normImageTag(tag) {
    return String(tag ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .trim()
      .replace(/^#+/u, "")
      .replace(/\s+/gu, "_")
      .replace(/[^\p{L}\p{N}_()'.:+-]/gu, "")
      .replace(/_+/gu, "_")
      .replace(/^_|_$/gu, "")
      .slice(0, 40);
  }

  function checkValue(schema, v) {
    if (schema.enum) return schema.enum.includes(v) ? v : null;
    if (schema.type === "integer") return Number.isInteger(v) && v >= schema.minimum && v <= schema.maximum ? v : null;
    if (schema.type === "boolean") return typeof v === "boolean" ? v : null;
    if (schema.type === "string") return typeof v === "string" ? v.trim().slice(0, schema.maxLength) : null;
    if (schema.type === "array") {
      if (!Array.isArray(v)) return null;
      return [...new Set(v.map(normImageTag).filter(Boolean))].slice(0, TAG_GUARD);
    }
    return null;
  }

  /**
   * Parse the model's reply into checked answers for `questions`. Accepts a
   * bare object, a ```json fence, or text around one object. Unknown keys are
   * dropped; a missing or out-of-range field becomes null rather than failing
   * the scan. Throws when there is no usable JSON object.
   */
  function parseAnswers(text, questions) {
    const raw = String(text ?? "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("No JSON object in the model's reply");
    let value;
    try {
      value = JSON.parse(raw.slice(start, end + 1));
    } catch (error) {
      throw new Error(`Model reply is not valid JSON: ${error.message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model reply is not a JSON object");
    const out = {};
    let known = 0;
    for (const q of questions) {
      const ok = checkValue(q.schema, value[q.id]);
      out[q.id] = ok;
      if (ok !== null) known += 1;
    }
    if (known === 0) throw new Error("Model reply has none of the expected fields");
    // Reaching the guard means the model was probably looping (and was stopped there).
    if (Array.isArray(value.tags) && value.tags.length >= TAG_GUARD) out.tagsTruncated = true;
    return out;
  }

  /**
   * Fold new answers into a stored scan: only the questions just asked are
   * replaced, everything else is kept.
   */
  function mergeAnswers(scan, { cardId, avatarPath, avatarHash, questions, answers, at = new Date().toISOString() }) {
    const sameAvatar = scan && (scan.avatarPath ?? null) === (avatarPath ?? null);
    const base = sameAvatar ? scan : null;
    const next = {
      cardId,
      avatarPath: avatarPath ?? null,
      avatarHash: avatarHash ?? base?.avatarHash ?? null,
      answers: { ...(base?.answers ?? {}) },
      asked: { ...(base?.asked ?? {}) },
      scannedAt: at,
    };
    for (const q of questions) {
      next.answers[q.id] = answers[q.id] ?? null;
      next.asked[q.id] = questionKey(q);
    }
    if (questions.some((q) => q.id === "tags")) {
      if (answers.tagsTruncated) next.answers.tagsTruncated = true;
      else delete next.answers.tagsTruncated;
    }
    return next;
  }

  /**
   * 0.1 scans had one version for everything ("1:<profile hash>") and no
   * per-question keys. Mark the built-in questions they answered as asked
   * (their wording did not change), and profile_match when the profile is the
   * same, so only new questions (tags, categories) are asked again.
   * `avatarPath` is the card's, as 0.1 did not store it.
   */
  function migrateScan(scan, profile, avatarPath) {
    if (!scan || scan.asked || !scan.version) return scan;
    // 0.1 stored no avatar path; the card's current one is the best guess.
    if (!scan.answers) return { ...scan, noAvatar: true, asked: {}, avatarPath: null };
    const asked = {};
    for (const q of BUILTIN) if (q.id in scan.answers) asked[q.id] = questionKey(q);
    const [, profileHash] = String(scan.version).split(":");
    if (hasProfile(profile) && profileHash === hash32(profile.trim()) && Number.isInteger(scan.answers.profile_match)) {
      asked.profile_match = questionKey(profileQuestion(profile));
    }
    return { ...scan, asked, avatarPath: avatarPath ?? null };
  }

  // ── Picture tags (for the Character Manager) ──

  const IMAGE_PREFIX = "image:";

  /**
   * Picture tags for one scan: every free tag as `image:<tag>`, the built-in
   * answers as `image:<field>:<value>` (numbers also as `image:<field>` when
   * above 0, and cumulatively, so `image:nsfw:2` means "2 or more"), and each
   * enabled category the same way: `image:inflation`, `image:inflation:1`…
   */
  function imageTags(answers, { categories = [] } = {}) {
    if (!answers) return [];
    const out = new Set();
    const level = (name, value, max) => {
      if (!Number.isInteger(value) || value <= 0) return;
      out.add(`${IMAGE_PREFIX}${name}`);
      for (let k = 1; k <= Math.min(value, max); k += 1) out.add(`${IMAGE_PREFIX}${name}:${k}`);
    };
    for (const q of BUILTIN) {
      const v = answers[q.id];
      if (v === null || v === undefined) continue;
      if (q.schema.enum) out.add(`${IMAGE_PREFIX}${q.id}:${v}`);
      else if (q.schema.type === "integer") level(q.id, v, q.schema.maximum);
      else if (q.schema.type === "boolean" && v) out.add(`${IMAGE_PREFIX}${q.id}`);
    }
    for (const c of categories) if (c?.enabled) level(c.id, answers[categoryField(c.id)], 3);
    for (const t of Array.isArray(answers.tags) ? answers.tags : []) out.add(`${IMAGE_PREFIX}${t}`);
    return [...out];
  }

  // ── Features ──

  const normTag = (tag) => String(tag ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const STOP = new Set("a an the of and or with in on at to is are her his their its wearing holding image picture character".split(" "));
  const captionWords = (caption) =>
    [...new Set(String(caption ?? "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));

  /**
   * Sparse features for one card: `answers` (null when not scanned yet) plus
   * catalog metadata. Returns Map name -> value. `categories` limits category
   * answers to the ones still in use; `imageOnly` leaves out tags and creator.
   */
  function features(answers, card = {}, { imageOnly = false, categories = null } = {}) {
    const x = new Map();
    if (answers) {
      for (const q of BUILTIN) {
        const v = answers[q.id];
        if (v === null || v === undefined) continue;
        if (q.schema.enum) x.set(`${q.id}=${v}`, 1);
        else if (q.schema.type === "integer") x.set(q.id, v / q.schema.maximum);
        else if (q.schema.type === "boolean") x.set(q.id, v ? 1 : 0);
      }
      if (Array.isArray(answers.tags)) for (const t of answers.tags) x.set(`it:${t}`, 0.5);
      else for (const w of captionWords(answers.caption)) x.set(`w:${w}`, 0.5); // 0.1 scans
      const inUse = categories ? new Set(categories.filter((c) => c?.enabled).map((c) => categoryField(c.id))) : null;
      for (const [key, v] of Object.entries(answers)) {
        if (!key.startsWith("cat_") || !Number.isInteger(v) || (inUse && !inUse.has(key))) continue;
        x.set(key, v / 3);
      }
      if (Number.isInteger(answers.profile_match)) x.set("profile_match", (answers.profile_match - 1) / 4);
    } else {
      x.set("unscanned", 1);
    }
    if (!imageOnly) {
      for (const tag of card.tags ?? []) {
        const t = normTag(tag);
        if (t) x.set(`t:${t}`, 1);
      }
      if (card.creator) x.set(`c:${normTag(card.creator)}`, 1);
    }
    return x;
  }

  // ── Model: L2-regularised logistic regression, plain SGD over sparse rows ──

  const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

  /** Deterministic PRNG so training (and the tests) are repeatable. */
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  /**
   * rows: [{ x: Map, y: 0|1, w?: weight }]. Classes are rebalanced so a library
   * where most decisions are deletes (or keeps) still learns both sides.
   */
  function train(rows, { epochs = 40, rate = 0.3, l2 = 1e-3, seed = 7 } = {}) {
    const weights = new Map();
    let bias = 0;
    if (!rows.length) return { weights, bias, n: 0 };
    const pos = rows.reduce((s, r) => s + (r.y ? r.w ?? 1 : 0), 0);
    const neg = rows.reduce((s, r) => s + (r.y ? 0 : r.w ?? 1), 0);
    const balance = (y) => (pos && neg ? (pos + neg) / (2 * (y ? pos : neg)) : 1);
    const order = rows.map((_, i) => i);
    const random = rng(seed);
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const step = rate / (1 + epoch * 0.1);
      for (const i of order) {
        const { x, y, w = 1 } = rows[i];
        let z = bias;
        for (const [k, v] of x) z += (weights.get(k) ?? 0) * v;
        const g = (sigmoid(z) - y) * w * balance(y);
        bias -= step * g;
        for (const [k, v] of x) {
          const old = weights.get(k) ?? 0;
          weights.set(k, old - step * (g * v + l2 * old));
        }
      }
    }
    return { weights, bias, n: rows.length };
  }

  function predict(model, x) {
    let z = model.bias;
    for (const [k, v] of x) z += (model.weights.get(k) ?? 0) * v;
    return sigmoid(z);
  }

  /** k-fold accuracy, to show whether the model is learning anything. */
  function crossValidate(rows, { folds = 5, ...options } = {}) {
    if (rows.length < folds * 2) return null;
    let correct = 0;
    let weight = 0;
    for (let f = 0; f < folds; f += 1) {
      const trainRows = rows.filter((_, i) => i % folds !== f);
      const test = rows.filter((_, i) => i % folds === f);
      const model = train(trainRows, options);
      for (const r of test) {
        const w = r.w ?? 1;
        weight += w;
        if ((predict(model, r.x) >= 0.5) === (r.y === 1)) correct += w;
      }
    }
    return weight ? correct / weight : null;
  }

  /** Largest weights, for "what it learned" in the panel. */
  function topWeights(model, count = 12) {
    const list = [...model.weights].filter(([, w]) => Math.abs(w) > 1e-6).sort((a, b) => b[1] - a[1]);
    return { dislike: list.slice(0, count), like: list.slice(-count).reverse() };
  }

  const bucket = (score) => (score === null || score === undefined ? null : Math.min(5, 1 + Math.floor(score * 5)));

  // ── Decisions -> training rows ──

  const IMPLIED_WEIGHT = 0.3;

  /** Newest decision per card. */
  function latestDecisions(decisions) {
    const byCard = new Map();
    for (const d of decisions) {
      const prev = byCard.get(d.cardId);
      if (!prev || d.at >= prev.at) byCard.set(d.cardId, d);
    }
    return [...byCard.values()];
  }

  /** Deletes with learn=false only feed the tag statistics, not the model. */
  function trainingRows(decisions, answersFor, options = {}) {
    const rows = [];
    for (const d of latestDecisions(decisions)) {
      if (d.decision === "delete" && d.learn === false) continue;
      const answers = answersFor(d.cardId) ?? d.answers ?? null;
      const y = d.decision === "delete" ? 1 : 0;
      const w = d.decision === "implied-keep" ? IMPLIED_WEIGHT : 1;
      rows.push({ x: features(answers, d, options), y, w, cardId: d.cardId });
    }
    return rows;
  }

  /**
   * Tags you delete more than keep. Smoothed log-odds against your overall
   * delete rate, so a tag on 2 of 2 deletes does not outrank one on 40 of 50.
   * `tagsOf(decision)` picks the tags (default: the card's own tags).
   */
  function dislikedTags(decisions, { minDeletes = 5, prior = 2, learnOnly = false, tagsOf = (d) => d.tags ?? [], keyOf = normTag } = {}) {
    const latest = latestDecisions(decisions).filter((d) => !(learnOnly && d.decision === "delete" && d.learn === false));
    const deletes = latest.filter((d) => d.decision === "delete").length;
    const keeps = latest.length - deletes;
    if (!deletes || !keeps) return [];
    const rate = deletes / latest.length;
    const counts = new Map(); // key -> [label, deletes, keeps]
    for (const d of latest) {
      for (const raw of new Set(tagsOf(d))) {
        const key = keyOf(raw);
        if (!key) continue;
        const entry = counts.get(key) ?? [String(raw).trim(), 0, 0];
        if (d.decision === "delete") entry[1] += 1;
        else entry[2] += d.decision === "implied-keep" ? IMPLIED_WEIGHT : 1;
        counts.set(key, entry);
      }
    }
    const out = [];
    for (const [key, [label, del, keep]] of counts) {
      if (del < minDeletes) continue;
      const p = (del + prior * rate) / (del + keep + prior);
      const strength = Math.log(p / (1 - p)) - Math.log(rate / (1 - rate));
      if (strength <= 0) continue;
      out.push({ key, tag: label, deletes: del, keeps: Math.round(keep * 10) / 10, deleteRate: del / (del + keep), strength });
    }
    return out.sort((a, b) => b.strength - a.strength || b.deletes - a.deletes);
  }

  // ── Backups ──

  const BACKUP_KIND = "char-triage-backup";

  function makeBackup({ settings, decisions, scans }) {
    return { kind: BACKUP_KIND, version: 2, exportedAt: new Date().toISOString(), settings, decisions, scans };
  }

  /** JSON with object keys sorted, to compare scans regardless of key order. */
  const stableJson = (value) =>
    JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

  /** Two scans of one card: per question, the newer answer wins (if they are for the same avatar). */
  function mergeScan(a, b) {
    if (!a) return b;
    if (!b) return a;
    const [older, newer] = (a.scannedAt ?? "") <= (b.scannedAt ?? "") ? [a, b] : [b, a];
    if ((older.avatarPath ?? null) !== (newer.avatarPath ?? null) || !older.asked || !newer.asked || !older.answers || !newer.answers) return newer;
    return {
      ...newer,
      answers: { ...older.answers, ...newer.answers },
      asked: { ...older.asked, ...newer.asked },
    };
  }

  /**
   * Merge a backup into what is stored. Decisions are a log: kept unless the
   * same card+time+decision is already there. Scans merge per question.
   */
  function mergeBackup(current, backup) {
    if (backup?.kind !== BACKUP_KIND) throw new Error("Not a Char Triage backup file");
    const seen = new Set(current.decisions.map((d) => `${d.cardId}\n${d.at}\n${d.decision}`));
    const decisions = [...current.decisions];
    let addedDecisions = 0;
    for (const d of backup.decisions ?? []) {
      if (!d?.cardId || !d.at || !d.decision) continue;
      const key = `${d.cardId}\n${d.at}\n${d.decision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      decisions.push(d);
      addedDecisions += 1;
    }
    const scans = new Map(current.scans.map((s) => [s.cardId, s]));
    let addedScans = 0;
    for (const s of backup.scans ?? []) {
      if (!s?.cardId || (!s.answers && !s.noAvatar)) continue;
      const prev = scans.get(s.cardId);
      const merged = mergeScan(prev, s);
      if (merged !== prev && stableJson(merged) !== stableJson(prev)) {
        scans.set(s.cardId, merged);
        addedScans += 1;
      }
    }
    return { decisions, scans: [...scans.values()], addedDecisions, addedScans };
  }

  return Object.freeze({
    BUILTIN,
    CATEGORY_PRESETS,
    CATEGORY_LEVELS,
    categoryRubric,
    IMAGE_PREFIX,
    TAG_GUARD,
    slug,
    categoryField,
    categoryQuestion,
    activeQuestions,
    questionKey,
    missingQuestions,
    answerSchema,
    prompt,
    hash32,
    normImageTag,
    parseAnswers,
    mergeAnswers,
    migrateScan,
    imageTags,
    normTag,
    features,
    train,
    predict,
    crossValidate,
    topWeights,
    bucket,
    latestDecisions,
    trainingRows,
    dislikedTags,
    makeBackup,
    mergeScan,
    mergeBackup,
    IMPLIED_WEIGHT,
  });
})();

// Char Triage: pure logic, no DOM or network. The vision prompt and its JSON
// schema, parsing the model's answer, turning answers + card metadata into
// features, a small logistic regression trained on the user's own decisions,
// tag statistics and backup merging. Unit-tested in test/core.test.mjs.

const CTR = (() => {
  "use strict";

  // Bump when the questions change: scans made with another version are redone.
  const PROMPT_VERSION = 1;

  /** Each question: JSON schema for the answer, and the rubric line the model reads. */
  const QUESTIONS = Object.freeze({
    style: {
      schema: { enum: ["anime", "semi_realistic", "3d_render", "photo", "painterly", "sketch", "pixel", "other"] },
      rubric: "art style: anime (anime/manga/cel-shaded), semi_realistic, 3d_render (CGI, game/Daz/Koikatsu renders), photo (real photograph), painterly (digital or traditional painting), sketch (line art, unfinished), pixel, other",
    },
    ai_artifacts: {
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: "signs of AI generation: 0 none visible, 1 subtle (too-smooth skin, generic glossy look), 2 obvious (malformed hands, eyes or fingers, melted details, garbled background objects), 3 severe (badly broken anatomy or faces)",
    },
    image_quality: {
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: "technical quality: 0 very poor (tiny, blurry, heavily compressed, cropped badly), 1 poor, 2 decent, 3 high (crisp, clean, well composed)",
    },
    low_effort: {
      schema: { type: "boolean" },
      rubric: "true if the image is a screenshot, meme, plain text, logo, placeholder, collage or otherwise not a proper character picture",
    },
    text_overlay: {
      schema: { enum: ["none", "small", "prominent"] },
      rubric: "text, captions, logos or watermarks drawn on the image: none, small (corner signature or watermark), prominent (titles, big captions, text covering the picture)",
    },
    nsfw: {
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: "sexual content: 0 safe, 1 suggestive (revealing clothes, pin-up pose), 2 partial nudity, 3 explicit",
    },
    gore: {
      schema: { type: "integer", minimum: 0, maximum: 3 },
      rubric: "violence or gore: 0 none, 1 mild (weapons, small wounds), 2 bloody, 3 graphic",
    },
    framing: {
      schema: { enum: ["face", "portrait", "full_body", "scene", "no_character"] },
      rubric: "framing of the main character: face (head only), portrait (head and torso), full_body, scene (characters small in a wider scene), no_character",
    },
    subjects: {
      schema: { enum: ["none", "one", "two", "group"] },
      rubric: "how many characters are shown",
    },
    presentation: {
      schema: { enum: ["female", "male", "mixed", "ambiguous", "none"] },
      rubric: "gender presentation of the character(s) shown",
    },
    species: {
      schema: { enum: ["human", "humanlike", "furry", "monster", "robot", "object", "none"] },
      rubric: "what the main character is: human, humanlike (elf, demon, kemonomimi with animal ears/tail), furry (anthro animal), monster, robot, object (no living character), none",
    },
    background: {
      schema: { enum: ["plain", "simple", "detailed"] },
      rubric: "background: plain (flat colour or transparent), simple, detailed",
    },
    palette: {
      schema: { enum: ["dark", "bright", "pastel", "muted", "monochrome", "neon"] },
      rubric: "overall colours",
    },
    tone: {
      schema: { enum: ["wholesome", "neutral", "romantic", "sexual", "dark", "comedic"] },
      rubric: "overall mood of the image",
    },
    caption: {
      schema: { type: "string", maxLength: 160 },
      rubric: "a plain description of the image in at most 15 words",
    },
  });
  const PROFILE_QUESTION = {
    schema: { type: "integer", minimum: 1, maximum: 5 },
    rubric: "how well this image matches what the user DISLIKES (described below): 1 not at all, 3 partly, 5 exactly what they dislike",
  };

  const hasProfile = (profile) => typeof profile === "string" && profile.trim().length > 0;

  /** JSON schema for the answer; `profile_match` only when there is a dislike profile. */
  function answerSchema(profile) {
    const properties = {};
    for (const [key, q] of Object.entries(QUESTIONS)) properties[key] = q.schema;
    if (hasProfile(profile)) properties.profile_match = PROFILE_QUESTION.schema;
    return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
  }

  function prompt(profile) {
    const lines = Object.entries(QUESTIONS).map(([key, q]) => `- ${key}: ${q.rubric}`);
    if (hasProfile(profile)) lines.push(`- profile_match: ${PROFILE_QUESTION.rubric}`);
    const parts = [
      "You are labelling the avatar image of a roleplay character card. Look only at the image.",
      "Answer every field with a JSON object, nothing else. Judge what is visible; do not guess from style alone.",
      "",
      "Fields:",
      ...lines,
    ];
    if (hasProfile(profile)) parts.push("", "What the user dislikes:", profile.trim().slice(0, 2000));
    return parts.join("\n");
  }

  /** Version key for a scan: prompt version plus the profile it was asked with. */
  function scanVersion(profile) {
    return `${PROMPT_VERSION}:${hasProfile(profile) ? hash32(profile.trim()) : "-"}`;
  }

  function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * Parse the model's reply into checked answers. Accepts a bare object, a
   * ```json fence, or text around one object. Unknown keys are dropped; a
   * missing or out-of-range field becomes null rather than failing the scan.
   * Throws when there is no JSON object at all.
   */
  function parseAnswers(text) {
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
    const all = { ...QUESTIONS, profile_match: PROFILE_QUESTION };
    let known = 0;
    for (const [key, q] of Object.entries(all)) {
      const v = value[key];
      const s = q.schema;
      let ok = null;
      if (s.enum) ok = s.enum.includes(v) ? v : null;
      else if (s.type === "integer") ok = Number.isInteger(v) && v >= s.minimum && v <= s.maximum ? v : null;
      else if (s.type === "boolean") ok = typeof v === "boolean" ? v : null;
      else if (s.type === "string") ok = typeof v === "string" ? v.trim().slice(0, s.maxLength) : null;
      if (key === "profile_match" && v === undefined) continue;
      out[key] = ok;
      if (ok !== null) known += 1;
    }
    if (known === 0) throw new Error("Model reply has none of the expected fields");
    return out;
  }

  // ── Features ──

  const normTag = (tag) => String(tag ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const STOP = new Set("a an the of and or with in on at to is are her his their its wearing holding image picture character".split(" "));
  const captionWords = (caption) =>
    [...new Set(String(caption ?? "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));

  /**
   * Sparse features for one card: `answers` (may be null when not scanned yet)
   * plus catalog metadata. Returns Map name -> value. `imageOnly` leaves out
   * tags and creator.
   */
  function features(answers, card = {}, { imageOnly = false } = {}) {
    const x = new Map();
    if (answers) {
      for (const [key, q] of Object.entries(QUESTIONS)) {
        const v = answers[key];
        if (v === null || v === undefined) continue;
        if (q.schema.enum) x.set(`${key}=${v}`, 1);
        else if (q.schema.type === "integer") x.set(key, v / q.schema.maximum);
        else if (q.schema.type === "boolean") x.set(key, v ? 1 : 0);
      }
      for (const w of captionWords(answers.caption)) x.set(`w:${w}`, 0.5);
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

  /** k-fold accuracy and counts, to show whether the model is learning anything. */
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

  /**
   * decisions: newest per card wins. Deletes with learn=false only feed the
   * tag statistics, not the model.
   */
  function latestDecisions(decisions) {
    const byCard = new Map();
    for (const d of decisions) {
      const prev = byCard.get(d.cardId);
      if (!prev || d.at >= prev.at) byCard.set(d.cardId, d);
    }
    return [...byCard.values()];
  }

  function trainingRows(decisions, answersFor) {
    const rows = [];
    for (const d of latestDecisions(decisions)) {
      if (d.decision === "delete" && d.learn === false) continue;
      const answers = d.answers ?? answersFor(d.cardId) ?? null;
      const y = d.decision === "delete" ? 1 : 0;
      const w = d.decision === "implied-keep" ? IMPLIED_WEIGHT : 1;
      rows.push({ x: features(answers, d), y, w, cardId: d.cardId });
    }
    return rows;
  }

  /**
   * Tags you delete more than keep. Smoothed log-odds against your overall
   * delete rate, so a tag on 2 of 2 deletes does not outrank one on 40 of 50.
   */
  function dislikedTags(decisions, { minDeletes = 5, prior = 2, learnOnly = false } = {}) {
    const latest = latestDecisions(decisions).filter((d) => !(learnOnly && d.decision === "delete" && d.learn === false));
    const deletes = latest.filter((d) => d.decision === "delete").length;
    const keeps = latest.length - deletes;
    if (!deletes || !keeps) return [];
    const rate = deletes / latest.length;
    const counts = new Map(); // tag -> [label, deletes, keeps]
    for (const d of latest) {
      for (const raw of new Set(d.tags ?? [])) {
        const key = normTag(raw);
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
    return { kind: BACKUP_KIND, version: 1, exportedAt: new Date().toISOString(), settings, decisions, scans };
  }

  /**
   * Merge a backup into what is stored. Decisions are a log: kept unless the
   * same card+time+decision is already there. Scans: the newer per card wins.
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
      if (!s?.cardId || !s.answers) continue;
      const prev = scans.get(s.cardId);
      if (!prev || (s.scannedAt ?? "") > (prev.scannedAt ?? "")) {
        scans.set(s.cardId, s);
        addedScans += 1;
      }
    }
    return { decisions, scans: [...scans.values()], addedDecisions, addedScans };
  }

  return Object.freeze({
    PROMPT_VERSION,
    QUESTIONS,
    answerSchema,
    prompt,
    scanVersion,
    hash32,
    parseAnswers,
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
    mergeBackup,
    IMPLIED_WEIGHT,
  });
})();

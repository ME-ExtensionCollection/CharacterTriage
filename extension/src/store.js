// Char Triage: runtime state. Settings and your categories (marinara.storage,
// a few KB), scans and the decision log (IndexedDB, no Marinara size limit),
// the library catalog, picture tags, and the model: retrained from the
// decision log whenever it grows, then used to score every card. Listeners and
// the window event "marinara-char-triage:changed" hear about changes.

const CTRStore = (() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    connectionId: "",
    profile: "",
    learnFromDeletes: true,
    pauseImplied: false, // while true, "opened and not deleted" is not recorded
    categories: [], // [{ id, label, question, enabled }]
    concurrency: 4,
    scanning: false, // resume the scan after a reload
    decisionsSinceExport: 0,
    lastExportAt: null,
  });
  const MIN_ROWS = 30; // fewer decisions than this: fall back to profile_match
  const EXPORT_NUDGE = 200;
  const RETRAIN_DELAY = 1500;

  let settings = structuredClone(DEFAULTS);
  let scans = new Map(); // cardId -> scan
  let decisions = [];
  let cards = []; // catalog summary
  let cardsById = new Map();
  let scores = new Map(); // cardId -> 0..1
  let imageTagMap = null; // cardId -> ["image:…"], built on demand
  let model = null;
  let stats = { rows: 0, deletes: 0, keeps: 0, accuracy: null, mode: "none", trainedAt: null, top: null };
  let ready = null;
  let retrainTimer = 0;
  let saveTimer = 0;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) {
      try {
        fn();
      } catch (error) {
        marinara.log.error("Char Triage listener failed", error);
      }
    }
    window.dispatchEvent(new CustomEvent("marinara-char-triage:changed"));
  }

  function cleanCategories(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const c of list) {
      const id = CTR.slug(c?.id || c?.label);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: String(c.label || id).slice(0, 60), question: String(c.question || c.label || id).slice(0, 400), enabled: c.enabled !== false });
    }
    return out;
  }

  function load() {
    if (ready) return ready;
    ready = (async () => {
      const stored = (await marinara.storage.get())?.settings ?? {};
      for (const key of Object.keys(DEFAULTS)) {
        if (key === "categories") settings.categories = cleanCategories(stored.categories);
        else if (key === "lastExportAt") settings.lastExportAt = typeof stored.lastExportAt === "string" ? stored.lastExportAt : null;
        else if (key in stored && typeof stored[key] === typeof DEFAULTS[key]) settings[key] = stored[key];
      }
      settings.concurrency = Math.min(16, Math.max(1, Math.round(settings.concurrency)));
      const [allScans, allDecisions] = await Promise.all([CTRDb.allScans(), CTRDb.allDecisions()]);
      scans = new Map(allScans.map((s) => [s.cardId, s]));
      decisions = allDecisions;
      await refreshCatalog().catch((error) => marinara.log.warn("Char Triage: catalog load failed", error));
      await migrate();
      retrain();
    })();
    return ready;
  }

  /** 0.1 scans: give them per-question keys once (see CTR.migrateScan). */
  async function migrate() {
    const changed = [];
    for (const [id, scan] of scans) {
      const next = CTR.migrateScan(scan, settings.profile, cardsById.get(id)?.avatarPath || null);
      if (next !== scan) {
        scans.set(id, next);
        changed.push(next);
      }
    }
    if (changed.length) await CTRDb.putScans(changed);
  }

  async function refreshCatalog() {
    cards = await CTRApi.catalog();
    cardsById = new Map(cards.map((c) => [c.id, c]));
    imageTagMap = null;
    scoreAll();
  }

  function saveSettings(patch) {
    const categoriesChanged = "categories" in patch;
    if (categoriesChanged) patch = { ...patch, categories: cleanCategories(patch.categories) };
    Object.assign(settings, patch);
    marinara.clearTimeout(saveTimer);
    saveTimer = marinara.setTimeout(() => {
      void marinara.storage.patch({ settings: structuredClone(settings) }).catch((error) => marinara.log.error("Char Triage: saving settings failed", error));
    }, 400);
    // Categories decide picture tags and features.
    if (categoriesChanged) {
      imageTagMap = null;
      retrain();
    } else emit();
  }

  /** What every card should have been asked. */
  const questions = () => CTR.activeQuestions({ categories: settings.categories, profile: settings.profile });
  const featureOptions = () => ({ categories: settings.categories });

  // ── Model ──

  function scheduleRetrain() {
    marinara.clearTimeout(retrainTimer);
    retrainTimer = marinara.setTimeout(retrain, RETRAIN_DELAY);
  }

  function retrain() {
    retrainTimer = 0;
    const rows = CTR.trainingRows(decisions, (id) => scans.get(id)?.answers ?? null, featureOptions());
    const deletes = rows.filter((r) => r.y === 1).length;
    const keeps = rows.length - deletes;
    if (rows.length >= MIN_ROWS && deletes >= 5 && keeps >= 5) {
      model = CTR.train(rows);
      stats = {
        rows: rows.length,
        deletes,
        keeps,
        accuracy: CTR.crossValidate(rows),
        mode: "learned",
        trainedAt: new Date().toISOString(),
        top: CTR.topWeights(model),
      };
    } else {
      model = null;
      stats = { rows: rows.length, deletes, keeps, accuracy: null, mode: "profile", trainedAt: null, top: null };
    }
    scoreAll();
  }

  /** Score every card in the catalog. Unscanned cards still get tag/creator evidence. */
  function scoreAll() {
    const next = new Map();
    const options = featureOptions();
    for (const card of cards) {
      const answers = scans.get(card.id)?.answers ?? null;
      if (model) next.set(card.id, CTR.predict(model, CTR.features(answers, card, options)));
      else if (Number.isInteger(answers?.profile_match)) next.set(card.id, (answers.profile_match - 1) / 4);
    }
    scores = next;
    emit();
  }

  // ── Picture tags ──

  /** cardId -> picture tags ("image:…"), for every card with answers. */
  function imageTags() {
    if (!imageTagMap) {
      imageTagMap = new Map();
      for (const [id, scan] of scans) {
        const tags = CTR.imageTags(scan.answers, { categories: settings.categories });
        if (tags.length) imageTagMap.set(id, tags);
      }
    }
    return imageTagMap;
  }

  /** How many cards in the library still need each active question asked. */
  function pendingCounts() {
    const qs = questions();
    const counts = new Map(qs.map((q) => [q.id, 0]));
    let cardsPending = 0;
    let pictures = 0; // cards with an avatar to ask about
    for (const card of cards) {
      if (card.avatarPath && !(scans.get(card.id)?.noAvatar && scans.get(card.id)?.avatarPath === card.avatarPath)) pictures += 1;
      const missing = CTR.missingQuestions(scans.get(card.id), qs, card.avatarPath || "");
      if (missing.length) cardsPending += 1;
      for (const q of missing) counts.set(q.id, counts.get(q.id) + 1);
    }
    return { cardsPending, pictures, byQuestion: counts, questions: qs };
  }

  // ── Decisions ──

  function snapshot(card, decision, extra = {}) {
    return {
      cardId: card.id,
      decision,
      at: new Date().toISOString(),
      name: card.name ?? "",
      creator: card.creator ?? "",
      tags: Array.isArray(card.tags) ? [...card.tags] : [],
      answers: scans.get(card.id)?.answers ?? null,
      ...extra,
    };
  }

  async function record(list) {
    if (!list.length) return;
    await CTRDb.addDecisions(list);
    decisions.push(...list);
    saveSettings({ decisionsSinceExport: settings.decisionsSinceExport + list.length });
    scheduleRetrain();
  }

  const cardFor = (c) => (typeof c === "string" ? cardsById.get(c) : { ...cardsById.get(c.id), ...c });

  /**
   * Called before cards are deleted: logs the decision and keeps a small copy
   * of each avatar that still has questions to ask, so the card can be scanned
   * (and learned from) after it is gone. `learnById` overrides the
   * learn-from-deletes setting per card.
   */
  async function beforeDelete(list, { learnById = {} } = {}) {
    const targets = list.map(cardFor).filter((c) => c?.id);
    const qs = questions();
    const keepAvatars = [];
    await Promise.all(
      targets
        .filter((c) => c.avatarPath && CTR.missingQuestions(scans.get(c.id), qs, c.avatarPath).length)
        .map(async (c) => {
          try {
            const { dataUrl, hash } = await CTRApi.avatar(c.avatarPath);
            keepAvatars.push({ cardId: c.id, dataUrl, hash, avatarPath: c.avatarPath, card: { id: c.id, name: c.name, creator: c.creator, tags: c.tags }, savedAt: new Date().toISOString() });
          } catch (error) {
            marinara.log.debug("Char Triage: could not keep avatar", c.id, error);
          }
        }),
    );
    if (keepAvatars.length) await CTRDb.putAvatars(keepAvatars);
    await record(targets.map((c) => snapshot(c, "delete", { learn: learnById[c.id] ?? settings.learnFromDeletes })));
  }

  /**
   * Mark cards as fine. Implied keeps (opened, not deleted) skip cards that
   * already have a decision, and are not recorded at all while paused.
   */
  async function recordKeep(ids, { implied = false } = {}) {
    if (implied && settings.pauseImplied) return 0;
    const decided = implied ? new Set(decisions.map((d) => d.cardId)) : new Set();
    const list = ids
      .map(cardFor)
      .filter((c) => c?.id && !decided.has(c.id))
      .map((c) => snapshot(c, implied ? "implied-keep" : "keep"));
    await record(list);
    return list.length;
  }

  // ── Scans (written by the scanner) ──

  let scansSinceScore = 0;
  async function putScan(scan) {
    await CTRDb.putScan(scan);
    scans.set(scan.cardId, scan);
    // A new map (not edited in place), so readers can tell the picture tags changed.
    imageTagMap = null;
    // Fresh answers change scores and picture tags; tell listeners in batches, not per scan.
    if (++scansSinceScore >= 25) {
      scansSinceScore = 0;
      scheduleRetrain();
    }
  }

  // ── Maintenance ──

  /** Counts for the Storage section, plus the browser's own usage estimate. */
  async function storageStats() {
    const avatarIds = await CTRDb.allAvatarIds();
    let estimate = null;
    try {
      estimate = (await navigator.storage?.estimate?.()) ?? null;
    } catch {
      estimate = null;
    }
    let orphans = 0;
    const referenced = new Set(decisions.map((d) => d.cardId));
    let truncated = 0;
    for (const [id, scan] of scans) {
      if (!cardsById.has(id) && !referenced.has(id)) orphans += 1;
      if (scan.answers?.tagsTruncated) truncated += 1;
    }
    return { scans: scans.size, decisions: decisions.length, avatars: avatarIds.length, orphans, truncated, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
  }

  /**
   * Remove what nothing needs any more: scans of cards that are gone and no
   * decision refers to, kept avatars of gone cards that were scanned since,
   * and answers to categories you deleted. Decisions are never removed.
   */
  async function cleanup() {
    await refreshCatalog();
    const referenced = new Set(decisions.map((d) => d.cardId));
    const dropScans = [...scans.keys()].filter((id) => !cardsById.has(id) && !referenced.has(id));
    const dropping = new Set(dropScans);
    const qs = questions();
    const avatarIds = await CTRDb.allAvatarIds();
    const dropAvatars = avatarIds.filter((id) => !cardsById.has(id) && (!referenced.has(id) || (scans.has(id) && !CTR.missingQuestions(scans.get(id), qs).length)));
    const known = new Set(settings.categories.map((c) => CTR.categoryField(c.id)));
    const trimmed = [];
    for (const [id, scan] of scans) {
      if (dropping.has(id) || !scan.answers) continue;
      const stale = Object.keys(scan.answers).filter((k) => k.startsWith("cat_") && !known.has(k));
      if (!stale.length) continue;
      const next = { ...scan, answers: { ...scan.answers }, asked: { ...scan.asked } };
      for (const k of stale) {
        delete next.answers[k];
        delete next.asked[k];
      }
      trimmed.push(next);
    }
    await CTRDb.deleteScans(dropScans);
    await CTRDb.deleteAvatars(dropAvatars);
    if (trimmed.length) await CTRDb.putScans(trimmed);
    for (const id of dropScans) scans.delete(id);
    for (const s of trimmed) scans.set(s.cardId, s);
    imageTagMap = null;
    retrain();
    return { scans: dropScans.length, avatars: dropAvatars.length, trimmed: trimmed.length };
  }

  /** Forget everything stored in this browser (settings stay). */
  async function clearAll() {
    await CTRDb.clearAll();
    scans = new Map();
    decisions = [];
    imageTagMap = null;
    saveSettings({ decisionsSinceExport: 0 });
    retrain();
  }

  // ── Backup ──

  async function exportData() {
    const data = CTR.makeBackup({ settings: structuredClone(settings), decisions, scans: [...scans.values()] });
    saveSettings({ decisionsSinceExport: 0, lastExportAt: data.exportedAt });
    return data;
  }

  async function importData(backup) {
    const merged = CTR.mergeBackup({ decisions, scans: [...scans.values()] }, backup);
    await CTRDb.replaceDecisions(merged.decisions);
    await CTRDb.putScans(merged.scans);
    decisions = await CTRDb.allDecisions();
    scans = new Map(merged.scans.map((s) => [s.cardId, s]));
    await migrate();
    const s = backup.settings ?? {};
    const patch = {};
    if (typeof s.profile === "string" && !settings.profile) patch.profile = s.profile;
    // Categories from the backup that are not here yet.
    const have = new Set(settings.categories.map((c) => c.id));
    const extra = cleanCategories(s.categories).filter((c) => !have.has(c.id));
    if (extra.length) patch.categories = [...settings.categories, ...extra];
    imageTagMap = null;
    if (Object.keys(patch).length) saveSettings(patch);
    retrain();
    return merged;
  }

  return Object.freeze({
    load,
    refreshCatalog,
    saveSettings,
    questions,
    retrain,
    scheduleRetrain,
    beforeDelete,
    recordKeep,
    putScan,
    imageTags,
    pendingCounts,
    storageStats,
    cleanup,
    clearAll,
    exportData,
    importData,
    EXPORT_NUDGE,
    MIN_ROWS,
    get settings() {
      return settings;
    },
    get scans() {
      return scans;
    },
    get decisions() {
      return decisions;
    },
    get cards() {
      return cards;
    },
    get cardsById() {
      return cardsById;
    },
    get scores() {
      return scores;
    },
    get stats() {
      return stats;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
})();

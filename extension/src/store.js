// Char Triage: runtime state. Settings (marinara.storage), scans and the
// decision log (IndexedDB), the library catalog, and the model: retrained
// from the decision log whenever it grows, then used to score every card.
// Listeners and the window event "marinara-char-triage:changed" hear about
// new scores.

const CTRStore = (() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    connectionId: "",
    profile: "",
    learnFromDeletes: true,
    concurrency: 4,
    scanning: false, // resume the scan after a reload
    decisionsSinceExport: 0,
    lastExportAt: null,
  });
  const MIN_ROWS = 30; // fewer decisions than this: fall back to profile_match
  const EXPORT_NUDGE = 200;
  const RETRAIN_DELAY = 1500;

  let settings = { ...DEFAULTS };
  let scans = new Map(); // cardId -> scan
  let decisions = [];
  let cards = []; // catalog summary
  let cardsById = new Map();
  let scores = new Map(); // cardId -> 0..1
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

  function load() {
    if (ready) return ready;
    ready = (async () => {
      const stored = (await marinara.storage.get())?.settings ?? {};
      for (const key of Object.keys(DEFAULTS)) {
        if (key in stored && typeof stored[key] === typeof DEFAULTS[key]) settings[key] = stored[key];
        else if (key === "lastExportAt" && typeof stored[key] === "string") settings[key] = stored[key];
      }
      settings.concurrency = Math.min(16, Math.max(1, Math.round(settings.concurrency)));
      const [allScans, allDecisions] = await Promise.all([CTRDb.allScans(), CTRDb.allDecisions()]);
      scans = new Map(allScans.map((s) => [s.cardId, s]));
      decisions = allDecisions;
      await refreshCatalog().catch((error) => marinara.log.warn("Char Triage: catalog load failed", error));
      retrain();
    })();
    return ready;
  }

  async function refreshCatalog() {
    cards = await CTRApi.catalog();
    cardsById = new Map(cards.map((c) => [c.id, c]));
    scoreAll();
  }

  function saveSettings(patch) {
    Object.assign(settings, patch);
    marinara.clearTimeout(saveTimer);
    saveTimer = marinara.setTimeout(() => {
      void marinara.storage.patch({ settings: { ...settings } }).catch((error) => marinara.log.error("Char Triage: saving settings failed", error));
    }, 400);
    emit();
  }

  // ── Model ──

  function scheduleRetrain() {
    marinara.clearTimeout(retrainTimer);
    retrainTimer = marinara.setTimeout(retrain, RETRAIN_DELAY);
  }

  function retrain() {
    retrainTimer = 0;
    const rows = CTR.trainingRows(decisions, (id) => scans.get(id)?.answers ?? null);
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
    for (const card of cards) {
      const answers = scans.get(card.id)?.answers ?? null;
      if (model) next.set(card.id, CTR.predict(model, CTR.features(answers, card)));
      else if (Number.isInteger(answers?.profile_match)) next.set(card.id, (answers.profile_match - 1) / 4);
    }
    scores = next;
    emit();
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
   * of each unscanned avatar, so the card can still be scanned (and learned
   * from) after it is gone. `learnById` overrides the learn-from-deletes
   * setting per card.
   */
  async function beforeDelete(list, { learnById = {} } = {}) {
    const targets = list.map(cardFor).filter((c) => c?.id);
    const keepAvatars = [];
    await Promise.all(
      targets
        .filter((c) => !scans.get(c.id)?.answers && c.avatarPath)
        .map(async (c) => {
          try {
            const { dataUrl, hash } = await CTRApi.avatar(c.avatarPath);
            keepAvatars.push({ cardId: c.id, dataUrl, hash, card: { id: c.id, name: c.name, creator: c.creator, tags: c.tags }, savedAt: new Date().toISOString() });
          } catch (error) {
            marinara.log.debug("Char Triage: could not keep avatar", c.id, error);
          }
        }),
    );
    if (keepAvatars.length) await CTRDb.putAvatars(keepAvatars);
    await record(targets.map((c) => snapshot(c, "delete", { learn: learnById[c.id] ?? settings.learnFromDeletes })));
  }

  /** Mark cards as fine. Implied keeps (opened, not deleted) skip cards that already have a decision. */
  async function recordKeep(ids, { implied = false } = {}) {
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
    // Fresh answers change scores; rescoring 14k cards is cheap but not per scan.
    if (++scansSinceScore >= 25) {
      scansSinceScore = 0;
      scheduleRetrain();
    }
  }

  // ── Backup ──

  async function exportData() {
    const data = CTR.makeBackup({ settings: { ...settings }, decisions, scans: [...scans.values()] });
    saveSettings({ decisionsSinceExport: 0, lastExportAt: data.exportedAt });
    return data;
  }

  async function importData(backup) {
    const merged = CTR.mergeBackup({ decisions, scans: [...scans.values()] }, backup);
    await CTRDb.replaceDecisions(merged.decisions);
    await CTRDb.putScans(merged.scans);
    decisions = await CTRDb.allDecisions();
    scans = new Map(merged.scans.map((s) => [s.cardId, s]));
    if (typeof backup.settings?.profile === "string" && !settings.profile) saveSettings({ profile: backup.settings.profile });
    retrain();
    return merged;
  }

  return Object.freeze({
    load,
    refreshCatalog,
    saveSettings,
    retrain,
    scheduleRetrain,
    beforeDelete,
    recordKeep,
    putScan,
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

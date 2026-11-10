// Char Triage: the API other extensions use (Character Library's manager).
// window.marinaraCharTriage, read-mostly; "marinara-char-triage:changed" on
// window fires when scores change. Callers should check for the methods they
// need rather than the version number.

const CTRShare = (() => {
  "use strict";

  const latest = (id) => {
    let best = null;
    for (const d of CTRStore.decisions) if (d.cardId === id && (!best || d.at >= best.at)) best = d;
    return best;
  };

  const api = Object.freeze({
    version: 1,
    /** Resolves once settings, scans and decisions are loaded. */
    ready: () => CTRStore.load(),
    /** Map cardId -> dislike score 0..1 (cards without enough evidence are missing). */
    scores: () => CTRStore.scores,
    scoreOf: (id) => CTRStore.scores.get(id) ?? null,
    /** 1..5, or null. */
    bucketOf: (id) => CTR.bucket(CTRStore.scores.get(id)),
    answers: (id) => CTRStore.scans.get(id)?.answers ?? null,
    decisionOf: (id) => latest(id)?.decision ?? null,
    learnFromDeletes: () => CTRStore.settings.learnFromDeletes,
    /** cards: [{ id, name, creator, tags, avatarPath }] or ids. Log them before deleting. */
    beforeDelete: (cards, options) => CTRStore.beforeDelete(cards, options),
    /** ids or cards; { implied: true } for "opened and not deleted". Resolves with how many were recorded. */
    recordKeep: (cards, options) => CTRStore.recordKeep(cards, options),
    /** { running, done, failed, total, finishedAt, … } of the current or last scan. */
    scanState: () => ({ ...CTRScan.state }),
    openPanel: () => CTRUi.open(),
  });

  function install() {
    window.marinaraCharTriage = api;
    marinara.onCleanup(() => {
      if (window.marinaraCharTriage === api) delete window.marinaraCharTriage;
    });
    window.dispatchEvent(new CustomEvent("marinara-char-triage:changed"));
  }

  return Object.freeze({ install, api });
})();

// Char Triage: the API other extensions use (Character Library's manager).
// window.marinaraCharTriage, read-mostly; "marinara-char-triage:changed" on
// window fires when scores change. Callers should check for the methods they
// need rather than the version number.

const CTRShare = (() => {
  "use strict";

  // cardId -> latest decision, rebuilt when the decision log grows.
  let decisionMap = null;
  let decisionCount = -1;
  const decisionsById = () => {
    if (!decisionMap || decisionCount !== CTRStore.decisions.length) {
      decisionMap = new Map(CTR.latestDecisions(CTRStore.decisions).map((d) => [d.cardId, d.decision]));
      decisionCount = CTRStore.decisions.length;
    }
    return decisionMap;
  };
  const latest = (id) => decisionsById().get(id) ?? null;

  const api = Object.freeze({
    version: 1,
    /** Resolves once settings, scans and decisions are loaded. */
    ready: () => CTRStore.load(),
    /** Map cardId -> dislike score 0..1 (cards without enough evidence are missing). */
    scores: () => CTRStore.scores,
    scoreOf: (id) => CTRStore.scores.get(id) ?? null,
    /** 0..5 (score x 5, rounded), or null. */
    bucketOf: (id) => CTR.bucket(CTRStore.scores.get(id)),
    answers: (id) => CTRStore.scans.get(id)?.answers ?? null,
    decisionOf: (id) => latest(id),
    /** Map cardId -> "delete" | "keep" | "implied-keep" (latest decision per card). */
    decisions: () => decisionsById(),
    learnFromDeletes: () => CTRStore.settings.learnFromDeletes,
    /** cards: [{ id, name, creator, tags, avatarPath }] or ids. Log them before deleting. */
    beforeDelete: (cards, options) => CTRStore.beforeDelete(cards, options),
    /** ids or cards; { implied: true } for "opened and not deleted". Resolves with how many were recorded. */
    recordKeep: (cards, options) => CTRStore.recordKeep(cards, options),
    /** { running, done, failed, total, finishedAt, … } of the current or last scan. */
    scanState: () => ({ ...CTRScan.state }),
    /** Map cardId -> picture tags ("image:long_hair", "image:inflation:2", …). Never written to cards. */
    imageTags: () => CTRStore.imageTags(),
    imageTagsOf: (id) => CTRStore.imageTags().get(id) ?? [],
    /** Ask the vision model about these cards (only what each still needs). Resolves with how many had something to ask. */
    scanCards: (ids) => CTRScan.scanCards(ids),
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

// Char Triage: IndexedDB storage. Marinara's extension storage holds 1 MB,
// too little for 14k scans, so results live in the browser's IndexedDB and
// only settings go to marinara.storage. Export/Import (ui.js) is the backup.
//
// Stores:
//   scans      key cardId  { cardId, avatarPath, avatarHash, answers, asked: { question: key },
//                            scannedAt, noAvatar? }   (0.1 scans had `version` instead of `asked`)
//   decisions  auto key    { cardId, decision: delete|keep|implied-keep, learn, at,
//                            name, creator, tags, answers }   (a log, never rewritten)
//   avatars    key cardId  { cardId, dataUrl, hash, avatarPath, card, savedAt }  avatars kept from deleted,
//                            unscanned cards so they can still be scanned

const CTRDb = (() => {
  "use strict";

  const NAME = "char-triage";
  const VERSION = 1;
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("scans")) db.createObjectStore("scans", { keyPath: "cardId" });
        if (!db.objectStoreNames.contains("decisions")) {
          db.createObjectStore("decisions", { autoIncrement: true }).createIndex("cardId", "cardId");
        }
        if (!db.objectStoreNames.contains("avatars")) db.createObjectStore("avatars", { keyPath: "cardId" });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading: let it, and reopen next time.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error);
      };
    });
    return opening;
  }

  const done = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  async function tx(stores, mode, fn) {
    const db = await open();
    const t = db.transaction(stores, mode);
    const result = fn(...[stores].flat().map((s) => t.objectStore(s)));
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
    });
    return result instanceof IDBRequest ? result.result : result;
  }

  const getAll = (store) => tx(store, "readonly", (s) => s.getAll());

  return Object.freeze({
    allScans: () => getAll("scans"),
    allDecisions: () => getAll("decisions"),
    getScan: (cardId) => tx("scans", "readonly", (s) => s.get(cardId)),
    putScan: (scan) => tx("scans", "readwrite", (s) => void s.put(scan)),
    putScans: (scans) => tx("scans", "readwrite", (s) => scans.forEach((x) => s.put(x))),
    addDecisions: (list) => tx("decisions", "readwrite", (s) => list.forEach((d) => s.add(d))),
    replaceDecisions: (list) =>
      tx("decisions", "readwrite", (s) => {
        s.clear();
        list.forEach((d) => s.add(d));
      }),
    getAvatar: (cardId) => tx("avatars", "readonly", (s) => s.get(cardId)),
    putAvatars: (list) => tx("avatars", "readwrite", (s) => list.forEach((a) => s.put(a))),
    allAvatarIds: () => tx("avatars", "readonly", (s) => s.getAllKeys()),
    deleteAvatar: (cardId) => tx("avatars", "readwrite", (s) => void s.delete(cardId)),
    deleteAvatars: (ids) => tx("avatars", "readwrite", (s) => ids.forEach((id) => s.delete(id))),
    deleteScans: (ids) => tx("scans", "readwrite", (s) => ids.forEach((id) => s.delete(id))),
    async clearAll() {
      await tx(["scans", "decisions", "avatars"], "readwrite", (a, b, c) => {
        a.clear();
        b.clear();
        c.clear();
      });
    },
    done,
  });
})();

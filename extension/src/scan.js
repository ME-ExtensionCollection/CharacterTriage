// Char Triage: the scan job. Sends each card's avatar to the vision model and
// stores the answers. Newest cards first (the order you browse in), cards you
// already decided on before those (they train the model), skipping cards
// already scanned with the current prompt. Runs N requests at once, pauses on
// "too many requests", retries dropped connections, and picks up again after
// a reload. A Web Lock keeps it to one tab.

const CTRScan = (() => {
  "use strict";

  const LOCK = "char-triage-scan";
  const TRANSIENT_RETRIES = [2000, 5000];
  const GIVE_UP_AFTER = 10; // failures in a row: the model or connection is down
  const PILOT_SIZE = 300;

  let state = idle();
  const listeners = new Set();

  function idle() {
    return { running: false, stopping: false, pilot: false, done: 0, failed: 0, reused: 0, total: 0, startedAt: 0, lastError: "", waitingUntil: 0 };
  }

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (error) {
        marinara.log.error("Char Triage scan listener failed", error);
      }
    }
  };
  const sleep = (ms) => new Promise((resolve) => marinara.setTimeout(resolve, ms));

  /** What to scan, in order. Avatars kept from deleted cards first, then decided cards, then newest first. */
  async function plan({ pilot = false } = {}) {
    const version = CTR.scanVersion(CTRStore.settings.profile);
    const fresh = (id) => CTRStore.scans.get(id)?.version === version;
    const decided = new Set(CTRStore.decisions.map((d) => d.cardId));
    // Kept avatars stand in for cards that are gone; a card still in the library is scanned from its own avatar.
    const kept = (await CTRDb.allAvatarIds()).filter((id) => !fresh(id) && !CTRStore.cardsById.has(id));
    const live = CTRStore.cards.filter((c) => !fresh(c.id));
    const newest = (a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
    const decidedLive = live.filter((c) => decided.has(c.id)).sort(newest);
    const rest = live.filter((c) => !decided.has(c.id)).sort(newest);
    const jobs = [...kept.map((id) => ({ id, kept: true })), ...decidedLive.map((c) => ({ id: c.id, card: c })), ...rest.map((c) => ({ id: c.id, card: c }))];
    // Pilot: only cards you already judged, so the scores can be checked against you.
    return pilot ? jobs.filter((j) => j.kept || decided.has(j.id)).slice(0, PILOT_SIZE) : jobs;
  }

  async function start({ pilot = false } = {}) {
    if (state.running) return;
    const { connectionId, profile } = CTRStore.settings;
    if (!connectionId) throw new Error("Pick a connection first.");
    if (!navigator.locks) return run({ pilot, connectionId, profile });
    let ran = false;
    await navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await run({ pilot, connectionId, profile });
    });
    if (!ran) throw new Error("Already scanning in another tab.");
  }

  async function run({ pilot, connectionId, profile }) {
    await CTRStore.refreshCatalog().catch(() => {});
    const jobs = await plan({ pilot });
    state = { ...idle(), running: true, pilot, total: jobs.length, startedAt: Date.now() };
    if (!pilot) CTRStore.saveSettings({ scanning: true });
    emit();
    const version = CTR.scanVersion(profile);
    const prompt = CTR.prompt(profile);
    const schema = CTR.answerSchema(profile);
    // Identical images (re-imports) reuse a scan: hash -> answers, or the promise of them.
    const byHash = new Map();
    for (const s of CTRStore.scans.values()) if (s.version === version && s.avatarHash && s.answers) byHash.set(s.avatarHash, s.answers);
    const keptIds = new Set(await CTRDb.allAvatarIds());
    let next = 0;
    let pausedUntil = 0;

    const scanOne = async (job) => {
      let image;
      if (job.kept) {
        const saved = await CTRDb.getAvatar(job.id);
        if (!saved) return;
        image = { dataUrl: saved.dataUrl, hash: saved.hash };
      } else {
        try {
          image = await CTRApi.avatar(job.card.avatarPath);
        } catch (error) {
          if (!error.noAvatar) throw error;
          await CTRStore.putScan({ cardId: job.id, version, avatarHash: null, answers: null, error: error.message, scannedAt: new Date().toISOString() });
          return;
        }
      }
      const ask = async () => {
        for (let transient = 0; ; ) {
          const wait = pausedUntil - Date.now();
          if (wait > 0) await sleep(wait);
          try {
            const text = await CTRApi.describe({ connectionId, prompt, schema, dataUrl: image.dataUrl, runId: `ctr-${job.id}-${Date.now()}` });
            return CTR.parseAnswers(text);
          } catch (error) {
            if (error.status === 429) {
              const seconds = Math.min(Math.max(error.retryAfter ?? 10, 1), 120);
              pausedUntil = Math.max(pausedUntil, Date.now() + seconds * 1000);
              state.waitingUntil = pausedUntil;
              emit();
              continue;
            }
            const transientError = error.status === undefined || error.status >= 500;
            if (transientError && transient < TRANSIENT_RETRIES.length && !state.stopping) {
              await sleep(TRANSIENT_RETRIES[transient++]);
              continue;
            }
            throw error;
          }
        }
      };
      let answers = null;
      const shared = image.hash ? byHash.get(image.hash) : undefined;
      if (shared) {
        // Same image as another card (done, or still being asked about): share its answers.
        answers = await Promise.resolve(shared).catch(() => null);
        if (answers) state.reused += 1;
      }
      if (!answers) {
        const asking = ask();
        if (image.hash) byHash.set(image.hash, asking);
        try {
          answers = await asking;
        } catch (error) {
          if (image.hash && byHash.get(image.hash) === asking) byHash.delete(image.hash);
          throw error;
        }
        if (image.hash) byHash.set(image.hash, answers);
      }
      await CTRStore.putScan({ cardId: job.id, version, avatarHash: image.hash ?? null, answers, scannedAt: new Date().toISOString() });
      // The kept copy is no longer needed once the card has a scan.
      if (job.kept || keptIds.has(job.id)) await CTRDb.deleteAvatar(job.id);
    };

    let failedInARow = 0;
    const worker = async () => {
      while (next < jobs.length && !state.stopping) {
        const job = jobs[next++];
        try {
          await scanOne(job);
          state.done += 1;
          failedInARow = 0;
        } catch (error) {
          state.failed += 1;
          state.lastError = error.message;
          marinara.log.warn(`Char Triage: scan of ${job.id} failed`, error);
          // Everything failing (model down, wrong connection): stop instead of burning through the list.
          if (++failedInARow >= GIVE_UP_AFTER) {
            state.stopping = true;
            state.lastError = `Stopped after ${GIVE_UP_AFTER} failures in a row. ${error.message}`;
          }
        }
        state.waitingUntil = 0;
        emit();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CTRStore.settings.concurrency, jobs.length) }, worker));
    } finally {
      // Only a reload mid-run (this never runs) leaves `scanning` on, to resume.
      state = { ...state, running: false, stopping: false, finishedAt: Date.now() };
      if (!pilot) CTRStore.saveSettings({ scanning: false });
      CTRStore.retrain();
      emit();
    }
  }

  /** Let the requests in flight finish and start no more. */
  function stop() {
    if (!state.running) return;
    state.stopping = true;
    emit();
  }

  /** Seconds left at the pace so far. */
  function eta() {
    if (!state.running || !state.done) return null;
    const perCard = (Date.now() - state.startedAt) / state.done;
    return Math.round(((state.total - state.done - state.failed) * perCard) / 1000);
  }

  return Object.freeze({
    start,
    stop,
    plan,
    eta,
    PILOT_SIZE,
    get state() {
      return state;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
})();

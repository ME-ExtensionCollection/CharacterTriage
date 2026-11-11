// Char Triage: the scan job. Sends each card's avatar to the vision model with
// only the questions that card still needs (new categories, an edited profile,
// a new avatar), and folds the answers into its stored scan. Newest cards
// first (the order you browse in), cards you already decided on before those
// (they train the model). `scanCards(ids)` scans just the cards you pick in the
// Character Manager. Runs N requests at once, pauses on "too many requests",
// retries dropped connections, and picks up again after a reload. A Web Lock
// keeps it to one tab.

const CTRScan = (() => {
  "use strict";

  const LOCK = "char-triage-scan";
  const TRANSIENT_RETRIES = [2000, 5000];
  const GIVE_UP_AFTER = 10; // failures in a row: the model or connection is down
  const PILOT_SIZE = 300;

  let state = idle();
  let current = null; // the running job list, so scanCards() can add to it
  const listeners = new Set();

  function idle() {
    return { running: false, stopping: false, pilot: false, picked: false, done: 0, failed: 0, reused: 0, total: 0, startedAt: 0, lastError: "", waitingUntil: 0 };
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
  const newest = (a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));

  /** A job for a card still in the library, or null when it has nothing left to ask. */
  function liveJob(card, questions) {
    const missing = CTR.missingQuestions(CTRStore.scans.get(card.id), questions, card.avatarPath || "");
    return missing.length ? { id: card.id, card, missing } : null;
  }

  /**
   * What to scan, in order: avatars kept from deleted cards, then cards you
   * decided on, then the rest newest first. `ids` limits it to those cards
   * (in that order); `pilot` to cards you decided on.
   */
  async function plan({ pilot = false, ids = null } = {}) {
    const questions = CTRStore.questions();
    const decided = new Set(CTRStore.decisions.map((d) => d.cardId));
    const jobs = [];
    // Kept avatars stand in for cards that are gone; a card still in the library is scanned from its own avatar.
    for (const id of await CTRDb.allAvatarIds()) {
      if (CTRStore.cardsById.has(id) || (ids && !ids.includes(id))) continue;
      const missing = CTR.missingQuestions(CTRStore.scans.get(id), questions);
      if (missing.length) jobs.push({ id, kept: true, missing });
    }
    if (ids) {
      for (const id of ids) {
        const card = CTRStore.cardsById.get(id);
        const job = card && liveJob(card, questions);
        if (job) jobs.push(job);
      }
      return jobs;
    }
    const live = [...CTRStore.cards].sort(newest);
    for (const card of live) if (decided.has(card.id)) jobs.push(liveJob(card, questions));
    if (!pilot) for (const card of live) if (!decided.has(card.id)) jobs.push(liveJob(card, questions));
    const list = jobs.filter(Boolean);
    return pilot ? list.slice(0, PILOT_SIZE) : list;
  }

  async function start({ pilot = false, ids = null } = {}) {
    if (state.running) return;
    const { connectionId } = CTRStore.settings;
    if (!connectionId) throw new Error("Pick a connection first.");
    if (!navigator.locks) return run({ pilot, ids, connectionId });
    let ran = false;
    await navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await run({ pilot, ids, connectionId });
    });
    if (!ran) throw new Error("Already scanning in another tab.");
  }

  /**
   * Scan just these cards (only their missing questions). Joins a running scan,
   * else starts one. Resolves with how many cards had something to ask.
   */
  async function scanCards(ids) {
    const list = [...new Set(ids)];
    if (state.running && current) {
      const questions = CTRStore.questions();
      const queued = new Set(current.jobs.slice(current.next()).map((j) => j.id));
      let added = 0;
      // Picked cards go next, ahead of the rest of a full scan.
      const front = [];
      for (const id of list) {
        const card = CTRStore.cardsById.get(id);
        const job = card && !queued.has(id) && liveJob(card, questions);
        if (job) {
          front.push(job);
          added += 1;
        }
      }
      current.jobs.splice(current.next(), 0, ...front);
      state.total += added;
      emit();
      return added;
    }
    await CTRStore.refreshCatalog().catch(() => {});
    const jobs = await plan({ ids: list });
    if (!jobs.length) return 0;
    void start({ ids: list }).catch((error) => {
      state.lastError = error.message;
      emit();
    });
    return jobs.length;
  }

  async function run({ pilot, ids, connectionId }) {
    await CTRStore.refreshCatalog().catch(() => {});
    const jobs = await plan({ pilot, ids });
    state = { ...idle(), running: true, pilot, picked: !!ids, total: jobs.length, startedAt: Date.now() };
    const fullScan = !pilot && !ids;
    if (fullScan) CTRStore.saveSettings({ scanning: true });
    emit();
    // Identical images (re-imports): hash -> the scan of a card with that image, or the promise of it.
    const byHash = new Map();
    for (const s of CTRStore.scans.values()) if (s.avatarHash && s.answers) byHash.set(s.avatarHash, s);
    const keptIds = new Set(await CTRDb.allAvatarIds());
    let next = 0;
    let pausedUntil = 0;
    current = { jobs, next: () => next };

    const ask = async (job, image) => {
      const prompt = CTR.prompt(job.missing);
      const schema = CTR.answerSchema(job.missing);
      for (let transient = 0; ; ) {
        const wait = pausedUntil - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          const text = await CTRApi.describe({ connectionId, prompt, schema, dataUrl: image.dataUrl, runId: `ctr-${job.id}-${Date.now()}` });
          return CTR.parseAnswers(text, job.missing);
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

    /** Answers another card with the same image already has for all of `missing`, or null. */
    const covered = (scan, missing) => {
      if (!scan?.answers) return null;
      for (const q of missing) if (scan.asked?.[q.id] !== CTR.questionKey(q)) return null;
      return Object.fromEntries(missing.map((q) => [q.id, scan.answers[q.id] ?? null]));
    };

    const scanOne = async (job) => {
      let image;
      let avatarPath;
      if (job.kept) {
        const saved = await CTRDb.getAvatar(job.id);
        if (!saved) return;
        image = { dataUrl: saved.dataUrl, hash: saved.hash };
        avatarPath = saved.avatarPath ?? CTRStore.scans.get(job.id)?.avatarPath ?? null;
      } else {
        avatarPath = job.card.avatarPath || null;
        try {
          image = await CTRApi.avatar(avatarPath);
        } catch (error) {
          if (!error.noAvatar) throw error;
          await CTRStore.putScan({ cardId: job.id, avatarPath, avatarHash: null, noAvatar: true, answers: null, asked: {}, error: error.message, scannedAt: new Date().toISOString() });
          return;
        }
      }
      let answers = null;
      const shared = image.hash ? byHash.get(image.hash) : undefined;
      if (shared) {
        // Same image as another card (done, or still being asked about).
        answers = covered(await Promise.resolve(shared).catch(() => null), job.missing);
        if (answers) state.reused += 1;
      }
      let scan;
      if (answers) {
        scan = CTR.mergeAnswers(CTRStore.scans.get(job.id), { cardId: job.id, avatarPath, avatarHash: image.hash, questions: job.missing, answers });
      } else {
        const asking = ask(job, image).then((got) =>
          CTR.mergeAnswers(CTRStore.scans.get(job.id), { cardId: job.id, avatarPath, avatarHash: image.hash, questions: job.missing, answers: got }),
        );
        if (image.hash) byHash.set(image.hash, asking);
        try {
          scan = await asking;
        } catch (error) {
          if (image.hash && byHash.get(image.hash) === asking) byHash.delete(image.hash);
          throw error;
        }
      }
      if (image.hash) byHash.set(image.hash, scan);
      await CTRStore.putScan(scan);
      // The kept copy is no longer needed once the card has everything asked.
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
      // Cards added by scanCards() just as the last worker finished still get scanned.
      while (next < jobs.length && !state.stopping) {
        await Promise.all(Array.from({ length: Math.min(CTRStore.settings.concurrency, jobs.length - next) }, worker));
      }
    } finally {
      current = null;
      // Only a reload mid-run (this never runs) leaves `scanning` on, to resume.
      state = { ...state, running: false, stopping: false, finishedAt: Date.now() };
      if (fullScan) CTRStore.saveSettings({ scanning: false });
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
    scanCards,
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

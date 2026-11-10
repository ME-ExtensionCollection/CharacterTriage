// Mock Marinara host for the dev harness. Provides window.__marinaraRunFullPageExtension
// with a fake `marinara` API. `fetch` goes to the mock API in scripts/serve.mjs, so
// the extension sees the same HTTP shapes as on a real Marinara server.
(() => {
  "use strict";

  const STORE_KEY = "ctr-harness-storage";
  const log = (...args) => console.info("[mock marinara]", ...args);
  const cleanups = [];

  const readStore = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    } catch {
      return {};
    }
  };
  const storage = Object.freeze({
    async get() {
      return readStore();
    },
    async patch(value) {
      const next = { ...readStore(), ...value };
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      return next;
    },
    async delete() {
      localStorage.removeItem(STORE_KEY);
    },
  });

  window.__ctrHarness = {
    requests: 0,
    async stop() {
      for (const fn of cleanups.reverse()) await fn();
      cleanups.length = 0;
      log("extension stopped");
    },
    resetStorage: () => localStorage.removeItem(STORE_KEY),
  };

  const mockFetch = (input, init) => {
    window.__ctrHarness.requests += 1;
    return window.fetch(input, init);
  };

  window.__marinaraRunFullPageExtension = (identity, main) => {
    const api = Object.freeze({
      version: 1,
      extension: Object.freeze(identity),
      estimateTextTokens: (text) => Math.ceil(String(text).length / 4),
      log: Object.freeze({ debug: console.debug, info: console.info, warn: console.warn, error: console.error }),
      storage,
      fetch: mockFetch,
      setTimeout: (cb, ms, ...args) => window.setTimeout(cb, ms, ...args),
      clearTimeout: (id) => window.clearTimeout(id),
      setInterval: (cb, ms, ...args) => window.setInterval(cb, ms, ...args),
      clearInterval: (id) => window.clearInterval(id),
      onCleanup: (fn) => cleanups.push(fn),
    });
    queueMicrotask(() =>
      main(api).then(
        () => log("extension ready"),
        (error) => console.error("[mock marinara] extension failed", error),
      ),
    );
  };
})();

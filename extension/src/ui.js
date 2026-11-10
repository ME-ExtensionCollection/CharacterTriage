// Char Triage: the settings / progress panel. Opened from the Character
// Manager's toolbar (when Character Library is installed) or Alt+Shift+T.

const CTRUi = (() => {
  "use strict";

  let root = null;
  let unsubscribe = [];
  let renderFrame = 0;
  let connections = null;
  let connectionError = "";
  let tagsLearnOnly = false;

  /** h("div.a.b", { text, attrs, on }, ...children) */
  function h(spec, { text, attrs, on, ...props } = {}, ...children) {
    const [tag, ...classes] = spec.split(".");
    const node = document.createElement(tag || "div");
    if (classes.length) node.className = classes.join(" ");
    if (text !== undefined) node.textContent = text;
    for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
    for (const [k, fn] of Object.entries(on ?? {})) node.addEventListener(k, fn);
    Object.assign(node, props);
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  function toast(message, { error = false, duration = 6000, action = null } = {}) {
    const host = document.querySelector(".ctr-toasts") ?? document.body.appendChild(h("div.ctr-toasts"));
    const node = h(`div.ctr-toast${error ? ".ctr-toast--error" : ""}`, { attrs: { role: error ? "alert" : "status" } }, h("span", { text: message }));
    if (action) node.append(h("button.ctr-btn", { text: action.label, attrs: { type: "button" }, on: { click: () => (action.run(), node.remove()) } }));
    host.append(node);
    marinara.setTimeout(() => node.remove(), duration);
    return node;
  }

  const fmtDuration = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
  const pct = (x) => `${Math.round(x * 100)}%`;

  function featureLabel(name) {
    if (name.startsWith("t:")) return `tag “${name.slice(2)}”`;
    if (name.startsWith("c:")) return `creator “${name.slice(2)}”`;
    if (name.startsWith("w:")) return `looks like “${name.slice(2)}”`;
    if (name === "unscanned") return "not scanned yet";
    const [key, value] = name.split("=");
    const label = key.replace(/_/g, " ");
    return value ? `${label}: ${value.replace(/_/g, " ")}` : `high ${label}`;
  }

  function downloadJson(filename, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
    const a = h("a", { attrs: { href: url, download: filename } });
    document.body.append(a);
    a.click();
    a.remove();
    marinara.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function pickJsonFile() {
    return new Promise((resolve) => {
      const input = h("input", { attrs: { type: "file", accept: "application/json,.json", hidden: true } });
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return resolve(null);
        try {
          resolve({ name: file.name, json: JSON.parse(await file.text()) });
        } catch (error) {
          toast(`Could not read ${file.name}: ${error.message}`, { error: true });
          resolve(null);
        }
      });
      document.body.append(input);
      input.click();
    });
  }

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  // ── Char Importer (optional) ──

  const importer = () => {
    const api = window.marinaraCharImporter;
    return typeof api?.addProfileTagBlacklist === "function" ? api : null;
  };

  // ── Panel ──

  function open() {
    if (root) {
      root.querySelector(".ctr-panel")?.focus();
      return;
    }
    root = h("div.ctr-overlay", { on: { mousedown: (e) => e.target === root && close() } });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    });
    document.body.append(root);
    unsubscribe = [CTRStore.onChange(schedule), CTRScan.onChange(schedule)];
    void loadConnections();
    void CTRStore.load().then(schedule);
    render();
    root.querySelector(".ctr-panel")?.focus();
  }

  function close() {
    for (const fn of unsubscribe) fn();
    unsubscribe = [];
    root?.remove();
    root = null;
  }

  async function loadConnections() {
    try {
      connections = await CTRApi.connections();
      connectionError = "";
    } catch (error) {
      connections = [];
      connectionError = error.message;
    }
    schedule();
  }

  function schedule() {
    if (root && !renderFrame) renderFrame = requestAnimationFrame(render);
  }

  function section(title, ...children) {
    return h("section.ctr-section", {}, h("h3", { text: title }), ...children);
  }

  function render() {
    renderFrame = 0;
    if (!root) return;
    const scrollTop = root.querySelector(".ctr-panel")?.scrollTop ?? 0;
    const active = document.activeElement;
    // Do not rebuild under the user's typing in the profile box.
    if (active?.classList?.contains("ctr-profile") && root.contains(active)) {
      renderLive();
      return;
    }
    const panel = h(
      "div.ctr-panel",
      { attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Char Triage", tabindex: "-1" } },
      h("header.ctr-head", {}, h("h2", { text: "Char Triage" }), h("button.ctr-btn.ctr-close", { text: "×", attrs: { type: "button", title: "Close (Esc)", "aria-label": "Close" }, on: { click: close } })),
      connectionSection(),
      scanSection(),
      modelSection(),
      tagsSection(),
      backupSection(),
    );
    root.replaceChildren(panel);
    panel.scrollTop = scrollTop;
  }

  /** Cheap update of the numbers only (while typing). */
  function renderLive() {
    const node = root.querySelector(".ctr-scan-status");
    if (node) node.replaceWith(scanStatus());
  }

  function connectionSection() {
    const s = CTRStore.settings;
    const select = h(
      "select.ctr-input.ctr-connection",
      { attrs: { "aria-label": "Connection" }, on: { change: (e) => CTRStore.saveSettings({ connectionId: e.target.value }) } },
      h("option", { text: connections === null ? "Loading…" : "Choose a connection…", value: "" }),
      (connections ?? []).map((c) => h("option", { text: `${c.name}${c.model ? ` · ${c.model.split("/").pop()}` : ""}`, value: c.id, selected: c.id === s.connectionId })),
    );
    const profile = h("textarea.ctr-input.ctr-profile", {
      attrs: { rows: "3", placeholder: "Optional: what you dislike in card images, e.g. “3D renders, heavy AI artifacts, photos of real people, text over the picture”." },
      value: s.profile,
      on: { change: (e) => CTRStore.saveSettings({ profile: e.target.value }) },
    });
    const learn = h("label.ctr-check", {}, h("input.ctr-learn", { attrs: { type: "checkbox" }, checked: s.learnFromDeletes, on: { change: (e) => CTRStore.saveSettings({ learnFromDeletes: e.target.checked }) } }), " Learn from deletes by default (the delete dialog can change it per card)");
    return section(
      "Vision model",
      h("label.ctr-field", {}, h("span", { text: "Connection" }), select),
      connectionError ? h("p.ctr-error", { text: `Could not list connections: ${connectionError}` }) : null,
      h("p.ctr-muted", { text: "Needs a vision model (llama.cpp with --mmproj). Requests go through Marinara's server." }),
      h("label.ctr-field", {}, h("span", { text: "Dislike profile" }), profile),
      h("p.ctr-muted", { text: "Only a starting point before you have made ~30 decisions. Changing it means a new scan." }),
      learn,
    );
  }

  function scanStatus() {
    const st = CTRScan.state;
    const version = CTR.scanVersion(CTRStore.settings.profile);
    let current = 0;
    for (const sc of CTRStore.scans.values()) if (sc.version === version) current += 1;
    const total = CTRStore.cards.length;
    const parts = [`${current.toLocaleString()} of ${total.toLocaleString()} cards scanned`];
    if (st.running) {
      parts.push(`${st.pilot ? "pilot" : "this run"}: ${(st.done + st.failed).toLocaleString()} of ${st.total.toLocaleString()}`);
      if (st.reused) parts.push(`${st.reused} reused`);
      const eta = CTRScan.eta();
      if (eta !== null) parts.push(`about ${fmtDuration(eta)} left`);
      if (st.waitingUntil > Date.now()) parts.push("Marinara asked to slow down, waiting");
      if (st.stopping) parts.push("stopping…");
    }
    if (st.failed) parts.push(`${st.failed} failed`);
    return h(
      "div.ctr-scan-status",
      {},
      h("p", { text: parts.join(" · ") }),
      st.running ? h("progress.ctr-progress", { attrs: { max: String(st.total || 1), value: String(st.done + st.failed) } }) : null,
      st.lastError ? h("p.ctr-error", { text: `Last error: ${st.lastError}` }) : null,
    );
  }

  function scanSection() {
    const st = CTRScan.state;
    const s = CTRStore.settings;
    const startScan = (pilot) => () =>
      void CTRScan.start({ pilot }).catch((error) => toast(error.message, { error: true }));
    const buttons = st.running
      ? [h("button.ctr-btn.ctr-stop", { text: st.stopping ? "Stopping…" : "Stop", attrs: { type: "button", disabled: st.stopping }, on: { click: () => CTRScan.stop() } })]
      : [
          h("button.ctr-btn.ctr-on.ctr-start", { text: "Scan library", attrs: { type: "button", disabled: !s.connectionId, title: "Scan every card not scanned yet, newest first. Runs while Marinara is open; resumes after a reload." }, on: { click: startScan(false) } }),
          h("button.ctr-btn.ctr-pilot", { text: `Pilot: ${CTRScan.PILOT_SIZE} decided cards`, attrs: { type: "button", disabled: !s.connectionId, title: "Scan only cards you already kept or deleted, to check the model against your own calls." }, on: { click: startScan(true) } }),
        ];
    const concurrency = h("input.ctr-input.ctr-concurrency", {
      attrs: { type: "number", min: "1", max: "16", "aria-label": "Requests at once", title: "Match llama.cpp's --parallel (-np)" },
      value: String(s.concurrency),
      on: { change: (e) => CTRStore.saveSettings({ concurrency: Math.min(16, Math.max(1, Number(e.target.value) || 1)) }) },
    });
    return section(
      "Scan",
      scanStatus(),
      h("div.ctr-row", {}, ...buttons, h("label.ctr-inline", {}, "Requests at once ", concurrency)),
    );
  }

  function modelSection() {
    const st = CTRStore.stats;
    const lines = [];
    lines.push(`${st.rows.toLocaleString()} decisions used: ${st.deletes.toLocaleString()} deletes, ${st.keeps.toLocaleString()} keeps.`);
    if (st.mode === "learned") {
      lines.push(st.accuracy === null ? "" : `Predicts your call ${pct(st.accuracy)} of the time on decisions it was not trained on.`);
    } else {
      lines.push(`Learning starts at ${CTRStore.MIN_ROWS} decisions with at least 5 deletes and 5 keeps. Until then, scores come from the dislike profile.`);
    }
    const counts = [0, 0, 0, 0, 0];
    for (const v of CTRStore.scores.values()) counts[CTR.bucket(v) - 1] += 1;
    const top = st.top;
    return section(
      "What it learned",
      ...lines.filter(Boolean).map((t) => h("p", { text: t })),
      CTRStore.scores.size ? h("p.ctr-muted", { text: `Cards by score (1 = likely fine, 5 = likely disliked): ${counts.map((c, i) => `${i + 1}: ${c.toLocaleString()}`).join(" · ")}` }) : null,
      top
        ? h(
            "div.ctr-weights",
            {},
            h("div", {}, h("h4", { text: "Points to delete" }), h("ul", {}, top.dislike.slice(0, 8).map(([k]) => h("li", { text: featureLabel(k) })))),
            h("div", {}, h("h4", { text: "Points to keep" }), h("ul", {}, top.like.slice(0, 8).map(([k]) => h("li", { text: featureLabel(k) })))),
          )
        : null,
    );
  }

  function tagsSection() {
    const list = CTR.dislikedTags(CTRStore.decisions, { learnOnly: tagsLearnOnly }).slice(0, 60);
    const ci = importer();
    let onList = new Set();
    try {
      onList = new Set((ci?.profileTagBlacklist?.() ?? []).map(CTR.normTag));
    } catch {
      onList = new Set();
    }
    const filter = h(
      "label.ctr-check",
      {},
      h("input", { attrs: { type: "checkbox" }, checked: tagsLearnOnly, on: { change: (e) => ((tagsLearnOnly = e.target.checked), schedule()) } }),
      " Only deletes marked as being about the image",
    );
    const rows = list.map((t) =>
      h(
        "li.ctr-tag",
        {},
        h("span.ctr-tag-name", { text: t.tag }),
        h("span.ctr-muted", { text: `${t.deletes} deleted · ${t.keeps} kept` }),
        h("button.ctr-btn.ctr-copy", {
          text: "Copy",
          attrs: { type: "button", title: "Copy this tag" },
          on: {
            click: async (e) => {
              const button = e.currentTarget;
              try {
                await navigator.clipboard.writeText(t.tag);
                button.textContent = "Copied";
                marinara.setTimeout(() => (button.textContent = "Copy"), 1200);
              } catch (error) {
                toast(`Could not copy: ${error.message}`, { error: true });
              }
            },
          },
        }),
        h("button.ctr-btn.ctr-blacklist", {
          text: onList.has(t.key) ? "On blacklist" : "Blacklist",
          attrs: {
            type: "button",
            disabled: !ci || onList.has(t.key),
            title: ci ? "Add to Char Importer's profile tag blacklist (cards with it are skipped when a creator profile is imported)" : "Needs Char Importer with its sharing API (newer version)",
          },
          on: {
            click: async () => {
              try {
                await ci.addProfileTagBlacklist([t.tag]);
                toast(`Added “${t.tag}” to Char Importer's blacklist.`);
                schedule();
              } catch (error) {
                toast(`Could not add “${t.tag}”: ${error.message}`, { error: true });
              }
            },
          },
        }),
      ),
    );
    return section(
      "Tags you delete",
      h("p.ctr-muted", { text: "Tags on at least 5 deleted cards that you delete more often than usual. Strongest first." }),
      filter,
      rows.length ? h("ul.ctr-tags", {}, rows) : h("p.ctr-muted", { text: "Nothing yet: delete and keep some cards first." }),
    );
  }

  function backupSection() {
    const s = CTRStore.settings;
    return section(
      "Backup",
      h("p.ctr-muted", {
        text: `Decisions and scans live in this browser only. Export them to a file to keep or version them.${s.lastExportAt ? ` Last export ${new Date(s.lastExportAt).toLocaleString()}.` : " Never exported."}${s.decisionsSinceExport ? ` ${s.decisionsSinceExport.toLocaleString()} new decisions since.` : ""}`,
      }),
      h(
        "div.ctr-row",
        {},
        h("button.ctr-btn.ctr-export", { text: "Export…", attrs: { type: "button" }, on: { click: exportNow } }),
        h("button.ctr-btn.ctr-import", {
          text: "Import…",
          attrs: { type: "button", title: "Merge a backup into what is here" },
          on: {
            click: async () => {
              const file = await pickJsonFile();
              if (!file) return;
              try {
                const merged = await CTRStore.importData(file.json);
                toast(`Imported ${file.name}: ${merged.addedDecisions.toLocaleString()} decisions and ${merged.addedScans.toLocaleString()} scans added.`);
              } catch (error) {
                toast(`Import failed: ${error.message}`, { error: true });
              }
            },
          },
        }),
      ),
    );
  }

  async function exportNow() {
    const data = await CTRStore.exportData();
    downloadJson(`char-triage-backup-${stamp()}.json`, data);
  }

  /** After every 200 new decisions, offer an export. */
  function watchBackups() {
    let nudgedAt = 0;
    return CTRStore.onChange(() => {
      const n = CTRStore.settings.decisionsSinceExport;
      if (n >= CTRStore.EXPORT_NUDGE && n - nudgedAt >= CTRStore.EXPORT_NUDGE) {
        nudgedAt = n;
        toast(`${n.toLocaleString()} decisions since the last Char Triage backup.`, { duration: 20000, action: { label: "Export…", run: () => void exportNow() } });
      }
      if (n < nudgedAt) nudgedAt = 0;
    });
  }

  function install() {
    const onKey = (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT") {
        e.preventDefault();
        root ? close() : open();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const stopWatching = watchBackups();
    marinara.onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      stopWatching();
      close();
      document.querySelector(".ctr-toasts")?.remove();
    });
  }

  return Object.freeze({ open, close, install, toast });
})();

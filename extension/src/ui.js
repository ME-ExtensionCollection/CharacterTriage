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
  let tagSource = "card"; // "card" tags or "picture" tags in "Tags you delete"
  let pending = null; // CTRStore.pendingCounts(), once per render
  let storage = null; // last CTRStore.storageStats()
  let clearing = false; // "Clear everything" confirm row shown

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
    if (name.startsWith("it:")) return `picture tag “${name.slice(3)}”`;
    if (name.startsWith("cat_")) {
      const id = name.slice(4);
      return `${CTRStore.settings.categories.find((c) => c.id === id)?.label ?? id} in the picture`;
    }
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
    document.body.append(root);
    // Esc closes the panel wherever focus is: its buttons are rebuilt as the
    // scan progresses, which drops focus back to the page. Capture phase, so the
    // Character Manager underneath does not close too.
    window.addEventListener("keydown", onEscape, true);
    unsubscribe = [CTRStore.onChange(schedule), CTRScan.onChange(schedule)];
    void loadConnections();
    void CTRStore.load().then(schedule);
    render();
    root.querySelector(".ctr-panel")?.focus();
  }

  function onEscape(e) {
    if (e.key !== "Escape" || !root || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function close() {
    window.removeEventListener("keydown", onEscape, true);
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
    pending = CTRStore.pendingCounts();
    // Do not rebuild under the user's typing.
    if (root.contains(active) && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && /^(text|search|)$/u.test(active.type)))) {
      renderLive();
      return;
    }
    const panel = h(
      "div.ctr-panel",
      { attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Char Triage", tabindex: "-1" } },
      h("header.ctr-head", {}, h("h2", { text: "Char Triage" }), h("button.ctr-btn.ctr-close", { text: "×", attrs: { type: "button", title: "Close (Esc)", "aria-label": "Close" }, on: { click: close } })),
      connectionSection(),
      categoriesSection(),
      scanSection(),
      modelSection(),
      tagsSection(),
      backupSection(),
      storageSection(),
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
    const pause = h(
      "label.ctr-check",
      { attrs: { title: "While on, cards you open in the Character Manager and don't delete are not counted as fine. Handy while you hunt one category and leave the rest for later." } },
      h("input.ctr-pause-implied", { attrs: { type: "checkbox" }, checked: s.pauseImplied, on: { change: (e) => CTRStore.saveSettings({ pauseImplied: e.target.checked }) } }),
      " Pause automatic keeps (cards you open but don't delete)",
    );
    return section(
      "Vision model",
      h("label.ctr-field", {}, h("span", { text: "Connection" }), select),
      connectionError ? h("p.ctr-error", { text: `Could not list connections: ${connectionError}` }) : null,
      h("p.ctr-muted", { text: "Needs a vision model (llama.cpp with --mmproj). Requests go through Marinara's server." }),
      h("label.ctr-field", {}, h("span", { text: "Dislike profile" }), profile),
      h("p.ctr-muted", { text: "A starting point before you have made ~30 decisions. Changing it only re-asks this one question." }),
      learn,
      pause,
    );
  }

  function scanStatus() {
    const st = CTRScan.state;
    const total = CTRStore.cards.length;
    const left = pending?.cardsPending ?? 0;
    const parts = [left ? `${(total - left).toLocaleString()} of ${total.toLocaleString()} cards fully scanned · ${left.toLocaleString()} with questions to ask` : `All ${total.toLocaleString()} cards scanned`];
    if (st.running) {
      parts.push(`${st.pilot ? "pilot" : st.picked ? "picked cards" : "this run"}: ${(st.done + st.failed).toLocaleString()} of ${st.total.toLocaleString()}`);
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

  /** Your categories: each is one 0-3 question, and a picture tag (image:<id>, image:<id>:2 …). */
  function categoriesSection() {
    const s = CTRStore.settings;
    const list = s.categories;
    const total = CTRStore.cards.length;
    const save = (next) => CTRStore.saveSettings({ categories: next });
    const update = (id, patch) => save(list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const rows = list.map((c) => {
      const preset = CTR.CATEGORY_PRESETS.find((p) => p.id === c.id);
      // Added from an example whose wording has changed since (or that you edited).
      const differs =
        preset &&
        (preset.question !== c.question || (preset.zero ?? "") !== (c.zero ?? "") || (preset.levels ?? "") !== (c.levels ?? "") || CTR.categoryMax(preset) !== CTR.categoryMax(c));
      const missing = pending?.byQuestion.get(CTR.categoryField(c.id));
      const pictures = pending?.pictures ?? total;
      const status = c.enabled ? (missing ? `asked on ${Math.max(0, pictures - missing).toLocaleString()} of ${pictures.toLocaleString()} pictures` : "asked on every picture") : "off";
      return h(
        "li.ctr-category",
        { attrs: { "data-id": c.id } },
        h(
          "div.ctr-category-head",
          {},
          h("label.ctr-check", {}, h("input.ctr-category-on", { attrs: { type: "checkbox", "aria-label": `Ask about ${c.label}` }, checked: c.enabled, on: { change: (e) => update(c.id, { enabled: e.target.checked }) } }), h("strong", { text: ` ${c.label}` })),
          h("code.ctr-muted", { text: `image:${c.id}`, attrs: { title: `image:${c.id} is any level; image:${c.id}:2 is 2 or more (up to ${CTR.categoryMax(c)})` } }),
          h("span.ctr-muted.ctr-category-status", { text: status }),
          differs
            ? h("button.ctr-btn.ctr-category-reset", {
                text: "Reset to preset wording",
                attrs: { type: "button", title: `Use the example's current wording:\nLook for: ${preset.question}\nDoesn't count: ${preset.zero}\nOnly this question is asked again.` },
                on: { click: () => update(c.id, { question: preset.question, zero: preset.zero, levels: preset.levels ?? "", max: CTR.categoryMax(preset) }) },
              })
            : null,
          h("button.ctr-btn.ctr-category-delete", { text: "Remove", attrs: { type: "button", title: "Stop asking this. Its answers stay until Clean up." }, on: { click: () => save(list.filter((x) => x.id !== c.id)) } }),
        ),
        h(
          "label.ctr-field",
          {},
          h("span", { text: "Look for" }),
          h("input.ctr-input.ctr-category-question", {
            attrs: { type: "text", "aria-label": `What to look for: ${c.label}`, title: "What the model looks for. Changing it re-asks only this question." },
            value: c.question,
            on: { change: (e) => update(c.id, { question: e.target.value.trim() || c.label }) },
          }),
        ),
        c.levels
          ? h("p.ctr-muted.ctr-category-levels", { text: `Levels (0-${CTR.categoryMax(c)}): ${c.levels}`, attrs: { title: "This example uses its own scale. Reset to preset wording restores it." } })
          : null,
        h(
          "label.ctr-field",
          {},
          h("span", { text: "Doesn't count (rated 0)" }),
          h("input.ctr-input.ctr-category-zero", {
            attrs: { type: "text", "aria-label": `Doesn't count: ${c.label}`, placeholder: "not shown at all", title: "Lookalikes the model should rate 0. This matters most: without it, ordinary pictures get 1s and 2s." },
            value: c.zero ?? "",
            on: { change: (e) => update(c.id, { zero: e.target.value.trim() }) },
          }),
        ),
      );
    });
    const have = new Set(list.map((c) => c.id));
    const presets = CTR.CATEGORY_PRESETS.filter((p) => !have.has(p.id));
    const label = h("input.ctr-input.ctr-new-label", { attrs: { type: "text", placeholder: "Name, e.g. Tentacles", "aria-label": "New category name" } });
    const question = h("input.ctr-input.ctr-new-question", { attrs: { type: "text", placeholder: "Look for, e.g. tentacles wrapped around a character", "aria-label": "New category question" } });
    const zero = h("input.ctr-input.ctr-new-zero", { attrs: { type: "text", placeholder: "Doesn't count, e.g. octopus food, ropes, hair", "aria-label": "New category: what doesn't count" } });
    const add = () => {
      const id = CTR.slug(label.value);
      if (!id) return label.focus();
      if (have.has(id)) return toast(`There is already a category “${id}”.`, { error: true });
      save([...list, { id, label: label.value.trim(), question: question.value.trim() || label.value.trim(), zero: zero.value.trim(), enabled: true }]);
    };
    return section(
      "Categories",
      h("p.ctr-muted", {
        text: "Things you want found in pictures. Each is rated 0 (doesn't count), 1 a little or possibly, 2 clearly shown, 3 the point of the picture, and becomes a picture tag in the Character Manager: image:inflation is any level, image:inflation:2 is 2 or more. Say what doesn't count: lookalikes rated 0 keep ordinary pictures out. Adding or changing one only asks that question.",
      }),
      rows.length ? h("ul.ctr-categories", {}, rows) : null,
      presets.length
        ? h(
            "div.ctr-row.ctr-presets",
            {},
            h("span.ctr-muted", { text: "Examples:" }),
            presets.map((p) => h("button.ctr-btn.ctr-preset", { text: `+ ${p.label}`, attrs: { type: "button", "data-id": p.id, title: p.question }, on: { click: () => save([...list, { ...p, enabled: true }]) } })),
          )
        : null,
      h("div.ctr-row.ctr-new-category", {}, label, question, zero, h("button.ctr-btn.ctr-add-category", { text: "Add", attrs: { type: "button" }, on: { click: add } })),
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
          h("button.ctr-btn.ctr-on.ctr-start", { text: "Scan library", attrs: { type: "button", disabled: !s.connectionId, title: "Ask every card the questions it hasn't been asked yet, newest first. Runs while Marinara is open; resumes after a reload. To scan only some cards, select them in the Character Manager and use Ask Char Triage." }, on: { click: startScan(false) } }),
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
    lines.push(`${st.rows.toLocaleString()} decisions on scanned cards used: ${st.deletes.toLocaleString()} deletes, ${st.keeps.toLocaleString()} keeps. The score uses the picture only (scan answers), never card tags or creator.`);
    if (st.mode === "learned") {
      lines.push(st.accuracy === null ? "" : `Predicts your call ${pct(st.accuracy)} of the time on decisions it was not trained on.`);
    } else {
      lines.push(`Learning starts at ${CTRStore.MIN_ROWS} decisions with at least 5 deletes and 5 keeps. Until then, scores come from the dislike profile.`);
    }
    const counts = [0, 0, 0, 0, 0, 0];
    for (const v of CTRStore.scores.values()) counts[CTR.bucket(v)] += 1;
    const top = st.top;
    return section(
      "What it learned",
      ...lines.filter(Boolean).map((t) => h("p", { text: t })),
      CTRStore.hints.size
        ? h("p.ctr-muted", { text: `${CTRStore.hints.size.toLocaleString()} unscanned cards have a hint from their card tags and creator (shown as ?N in the Character Manager). Scan library does the likely-disliked ones first.` })
        : null,
      CTRStore.scores.size ? h("p.ctr-muted", { text: `Cards by score (0 = likely fine, 5 = likely disliked): ${counts.map((c, i) => `${i}: ${c.toLocaleString()}`).join(" · ")}` }) : null,
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
    const picture = tagSource === "picture";
    const pictureTagsOf = (d) => (CTRStore.scans.get(d.cardId)?.answers ?? d.answers)?.tags ?? [];
    const list = CTR.dislikedTags(CTRStore.decisions, picture ? { learnOnly: tagsLearnOnly, tagsOf: pictureTagsOf, keyOf: (t) => t } : { learnOnly: tagsLearnOnly }).slice(0, 60);
    const ci = importer();
    // Char Importer spells tags its own way (dark_elf), so let it say what is listed.
    const listed = (tag) => {
      try {
        if (typeof ci?.isOnProfileTagBlacklist === "function") return ci.isOnProfileTagBlacklist(tag);
        return (ci?.profileTagBlacklist?.() ?? []).map(CTR.normTag).includes(CTR.normTag(tag));
      } catch {
        return false;
      }
    };
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
        picture ? null : h("button.ctr-btn.ctr-blacklist", {
          text: listed(t.tag) ? "On blacklist" : "Blacklist",
          attrs: {
            type: "button",
            disabled: !ci || listed(t.tag),
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
      h(
        "div.ctr-row",
        {},
        ["card", "picture"].map((src) =>
          h(`button.ctr-btn.ctr-tag-source${tagSource === src ? ".ctr-on" : ""}`, {
            text: src === "card" ? "Card tags" : "Picture tags",
            attrs: { type: "button", "data-source": src },
            on: { click: () => ((tagSource = src), schedule()) },
          }),
        ),
      ),
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

  /** Counts, the browser's usage estimate, Clean up and Clear everything. */
  function storageSection() {
    if (!storage) void CTRStore.storageStats().then((st) => ((storage = st), schedule()));
    const st = storage;
    const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
    const typed = h("input.ctr-input.ctr-clear-typed", { attrs: { type: "text", placeholder: "Type CLEAR", "aria-label": "Type CLEAR to confirm" } });
    const confirmRow = clearing
      ? h(
          "div.ctr-row",
          {},
          h("span.ctr-error", { text: "Deletes every scan and decision in this browser. Export first if you might want them." }),
          typed,
          h("button.ctr-btn.ctr-clear-confirm", {
            text: "Clear",
            attrs: { type: "button" },
            on: {
              click: async () => {
                if (typed.value.trim() !== "CLEAR") return typed.focus();
                await CTRStore.clearAll();
                clearing = false;
                storage = null;
                toast("Cleared Char Triage's data in this browser.");
              },
            },
          }),
          h("button.ctr-btn", { text: "Cancel", attrs: { type: "button" }, on: { click: () => ((clearing = false), schedule()) } }),
        )
      : null;
    return section(
      "Storage",
      h("p.ctr-muted", {
        text: st
          ? `${st.scans.toLocaleString()} scans, ${st.decisions.toLocaleString()} decisions, ${st.avatars.toLocaleString()} kept avatars, in this browser's IndexedDB (not Marinara's extension storage).${st.usage !== null ? ` This site uses ${mb(st.usage)}${st.quota ? ` of ${mb(st.quota)} allowed` : ""}.` : ""}${st.orphans ? ` ${st.orphans.toLocaleString()} scans are for cards no longer in the library.` : ""}${st.truncated ? ` ${st.truncated.toLocaleString()} replies reached the ${CTR.TAG_GUARD}-tag guard (probably a looping reply, stopped there).` : ""}`
          : "Counting…",
      }),
      h(
        "div.ctr-row",
        {},
        h("button.ctr-btn.ctr-cleanup", {
          text: "Clean up",
          attrs: { type: "button", title: "Remove scans of deleted cards nothing refers to, kept avatars no longer needed, and answers to removed categories. Decisions are never removed." },
          on: {
            click: async () => {
              const r = await CTRStore.cleanup();
              storage = null;
              toast(`Removed ${r.scans.toLocaleString()} scans and ${r.avatars.toLocaleString()} kept avatars; trimmed ${r.trimmed.toLocaleString()} scans.`);
            },
          },
        }),
        h("button.ctr-btn.ctr-clear", { text: "Clear everything…", attrs: { type: "button" }, on: { click: () => ((clearing = true), schedule()) } }),
      ),
      confirmRow,
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

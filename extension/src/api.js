// Char Triage: talking to Marinara. The vision model is reached through one of
// Marinara's saved connections (POST /api/generate/raw), so the browser never
// calls llama.cpp itself: no CORS setup, and no https -> http mixed content.
//
// Routes:
//   GET  /api/characters/catalog?view=summary  every character (id, avatarPath, tags, creator, dates)
//   GET  /api/connections                      saved LLM connections
//   GET  /api/avatars/file/<name>              avatar image (full size, no thumbnails)
//   POST /api/generate/raw                     { connectionId, messages: [{ role, content, images }], parameters }
//   POST /api/generate/raw/abort               { runId }

const CTRApi = (() => {
  "use strict";

  const WRITE_HEADERS = { "Content-Type": "application/json", "x-marinara-csrf": "1" };
  const AVATAR_EDGE = 512;
  // Connection kinds that are not chat models.
  const NOT_CHAT = new Set(["image_generation", "video_generation", "tts", "stt", "embedding"]);

  async function request(path, init) {
    const response = await marinara.fetch(path, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      const error = new Error(`${init?.method ?? "GET"} ${path.split("?")[0]} failed: ${message}`);
      error.status = response.status;
      const retryAfter = Number(body?.retryAfter ?? response.headers?.get?.("Retry-After"));
      if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfter = retryAfter;
      throw error;
    }
    return body;
  }

  async function catalog() {
    const page = await request("/api/characters/catalog?view=summary");
    if (!Array.isArray(page?.items)) throw new Error("Unexpected catalog response");
    return page.items;
  }

  async function connections() {
    const body = await request("/api/connections");
    const list = Array.isArray(body) ? body : body?.connections ?? [];
    return list
      .filter((c) => c && c.id && !NOT_CHAT.has(c.provider))
      .map((c) => ({ id: c.id, name: c.name || c.id, model: c.model ?? "", provider: c.provider ?? "" }));
  }

  async function sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

  /**
   * The card's avatar, shrunk to at most 512 px as a JPEG data URL (fewer
   * image tokens, faster scans), plus a hash of the original file so an
   * identical re-import can reuse the scan.
   */
  async function avatar(path) {
    if (!path) throw Object.assign(new Error("Card has no avatar"), { noAvatar: true });
    const response = await marinara.fetch(path);
    if (!response.ok) {
      const error = new Error(`Avatar ${response.status}`);
      error.status = response.status;
      if (response.status === 404) error.noAvatar = true;
      throw error;
    }
    const blob = await response.blob();
    const hash = await sha256(await blob.arrayBuffer());
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw Object.assign(new Error("Avatar is not a readable image"), { noAvatar: true });
    }
    const scale = Math.min(1, AVATAR_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // transparent PNGs: JPEG has no alpha
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return { hash, dataUrl: await blobToDataUrl(jpeg) };
  }

  /**
   * Ask the vision model about one image. JSON-schema output and thinking
   * off are passed straight to the OpenAI-compatible server (llama.cpp
   * honours both). Returns the reply text.
   */
  async function describe({ connectionId, prompt, schema, dataUrl, runId, signal }) {
    const body = {
      connectionId,
      runId,
      streaming: false,
      messages: [{ role: "user", content: prompt, images: [dataUrl] }],
      parameters: {
        temperature: 0,
        maxTokens: 400,
        customParameters: {
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: "json_schema", json_schema: { name: "card_image", strict: true, schema } },
        },
      },
    };
    const reply = await request("/api/generate/raw", { method: "POST", headers: WRITE_HEADERS, body: JSON.stringify(body), signal });
    return typeof reply?.content === "string" ? reply.content : "";
  }

  function abort(runId) {
    return request("/api/generate/raw/abort", { method: "POST", headers: WRITE_HEADERS, body: JSON.stringify({ runId }) }).catch(() => {});
  }

  return Object.freeze({ request, catalog, connections, avatar, describe, abort });
})();

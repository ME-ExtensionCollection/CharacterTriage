// Mock Marinara API for the Char Triage dev harness: a catalog of generated
// cards, PNG avatars, saved connections, deletes, and a fake vision model on
// /api/generate/raw whose answers follow simple rules per card, so tests can
// check that the model learns them.
import { deflateSync } from "node:zlib";

const CREATORS = ["Kestrel", "pixie", "Moth", "anon", "Vale", "Rook"];
const TAGS = ["Female", "Male", "Fantasy", "Sci-Fi", "Modern", "Elf", "Romance", "Horror", "3D", "Anime", "OC", "NSFW"];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** The "truth" for a card, from its number: every third card is a 3D render. */
export function truth(n) {
  const render = n % 3 === 0;
  return {
    style: render ? "3d_render" : "anime",
    ai_artifacts: render ? 2 : 0,
    image_quality: render ? 1 : 3,
    low_effort: false,
    text_overlay: n % 7 === 0 ? "prominent" : "none",
    nsfw: n % 5 === 0 ? 1 : 0,
    gore: 0,
    framing: "portrait",
    subjects: "one",
    presentation: n % 2 ? "female" : "male",
    species: "human",
    background: render ? "detailed" : "simple",
    palette: render ? "muted" : "bright",
    tone: "neutral",
    tags: render ? ["1girl", "3d", "glossy_skin", "city", "night"] : ["1girl", "long_hair", "smile", "school_uniform"],
    // Categories: every 10th card shows inflation clearly, every 15th is vore.
    cat_inflation: n % 10 === 0 ? 2 : 0,
    cat_vore: n % 15 === 0 ? 3 : 0,
  };
}

// ── Tiny PNG encoder (solid colour), so createImageBitmap has a real raster to read ──
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function createMockApi({ count = 300, seed = 1 } = {}) {
  const api = { rows: [], stats: {}, options: {} };

  api.reset = ({ count: n = count, rateLimit = 0, delay = 60, fail = "" } = {}) => {
    const random = rng(seed);
    api.rows = Array.from({ length: n }, (_, i) => {
      const t = truth(i);
      const tags = TAGS.filter(() => random() < 0.25);
      if (t.style === "3d_render" && !tags.includes("3D")) tags.push("3D");
      return {
        id: `card-${String(i).padStart(5, "0")}`,
        n: i,
        name: `Card ${i}`,
        creator: CREATORS[i % CREATORS.length],
        tags,
        avatarPath: i % 50 === 49 ? "" : `/api/avatars/file/card-${i}.png`,
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
      };
    });
    // asked: the fields each answered request asked for (from its JSON schema).
    api.stats = { raw: 0, inFlight: 0, maxInFlight: 0, rateLimited: 0, avatars: 0, deletes: 0, asked: [] };
    // rateLimit: every Nth raw request answers 429 once. fail: "all" makes the model error.
    api.options = { rateLimit, delay, fail };
  };
  api.reset();

  const byId = (id) => api.rows.find((r) => r.id === id);
  const summary = ({ n, ...row }) => ({ ...row, comment: "", favorite: false, tokenEstimate: 1000, summary: "" });

  /** Returns [status, body] or null; raw requests are async (they take a while). */
  api.handle = async (method, url, body) => {
    const path = url.pathname;
    if (method === "GET" && path === "/api/characters/catalog") {
      if (url.searchParams.get("limit") === "1") return [200, { items: [], catalogGeneration: api.rows.length, hasMore: false }];
      return [200, { items: api.rows.map(summary), catalogGeneration: api.rows.length, hasMore: false }];
    }
    if (method === "GET" && path === "/api/connections") {
      return [200, [
        { id: "conn-vision", name: "Beast", provider: "custom", model: "/data/models/Qwen3.6-35B-A3B.gguf" },
        { id: "conn-comfy", name: "ComfyUI", provider: "image_generation", model: "sdxl" },
      ]];
    }
    const del = path.match(/^\/api\/characters\/([^/]+)$/);
    if (method === "DELETE" && del) {
      const i = api.rows.findIndex((r) => r.id === decodeURIComponent(del[1]));
      if (i < 0) return [404, { error: "Character not found" }];
      api.rows.splice(i, 1);
      api.stats.deletes += 1;
      return [204, null];
    }
    if (method === "POST" && path === "/api/generate/raw") {
      const number = ++api.stats.raw;
      api.stats.inFlight += 1;
      api.stats.maxInFlight = Math.max(api.stats.maxInFlight, api.stats.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, api.options.delay));
        if (api.options.rateLimit && number % api.options.rateLimit === 0) {
          api.stats.rateLimited += 1;
          return [429, { error: "Too many requests", retryAfter: 1 }];
        }
        if (api.options.fail === "all") return [500, { error: "model exploded" }];
        const image = body?.messages?.[0]?.images?.[0] ?? "";
        if (!image.startsWith("data:image/jpeg;base64,")) return [400, { error: "expected a JPEG data URL" }];
        if (body.parameters?.customParameters?.chat_template_kwargs?.enable_thinking !== false) return [400, { error: "thinking should be off" }];
        const schema = body.parameters?.customParameters?.response_format?.json_schema?.schema;
        if (!schema?.required?.length) return [400, { error: "missing schema" }];
        // The card number rides in the runId (ctr-<cardId>-<time>).
        const m = String(body.runId ?? "").match(/card-(\d+)/);
        const all = truth(m ? Number(m[1]) : 0);
        all.profile_match = all.style === "3d_render" ? 5 : 1;
        // Answer only what was asked (unknown categories: 0).
        const answers = Object.fromEntries(schema.required.map((k) => [k, k in all ? all[k] : k.startsWith("cat_") ? 0 : null]));
        api.stats.asked.push({ card: m ? Number(m[1]) : null, fields: schema.required });
        return [200, { content: "```json\n" + JSON.stringify(answers) + "\n```", runId: body.runId }];
      } finally {
        api.stats.inFlight -= 1;
      }
    }
    if (method === "POST" && path === "/api/generate/raw/abort") return [200, { aborted: false }];
    return null;
  };

  /**
   * Avatar bytes for /api/avatars/file/card-N.png, or null. One colour per
   * card; cards 98, 198, 298 are re-imports with the same image as the card
   * before them (so their scan can be reused).
   */
  api.avatar = (name) => {
    const m = name.match(/^card-(\d+)\.png$/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!api.rows.some((r) => r.n === n)) return null;
    api.stats.avatars += 1;
    const k = n % 100 === 98 ? n - 1 : n;
    return png(48, 64, [k % 256, Math.floor(k / 256), 200]);
  };

  api.byId = byId;
  return api;
}

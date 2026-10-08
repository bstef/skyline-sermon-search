// Shared helpers for the Pages Functions in functions/api/.
// Lives outside functions/ so it isn't routed, and outside public/ so it isn't served.

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export function json(data, { status = 200, maxAge = 0 } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

export function requireConfig(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new HttpError(500, "Server isn't configured: set SUPABASE_URL and SUPABASE_ANON_KEY.");
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function handleError(err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  return json({ error: err.message || "Something went wrong" }, { status });
}

/** Call Supabase's REST API with the public anon key (read-only under RLS). */
export async function supabase(env, path, { method = "GET", body } = {}) {
  requireConfig(env);
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(502, `Database error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Embed a search query with Workers AI. Returns null (keyword-only search) if unavailable. */
export async function embedQuery(env, text) {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run(EMBED_MODEL, { text: [text] });
    return out?.data?.[0] || null;
  } catch (err) {
    console.error("Embedding failed; falling back to keyword search", err);
    return null;
  }
}

/** Parse and clamp search parameters from a URL's query string. */
export function readSearchParams(url) {
  const p = url.searchParams;
  const q = (p.get("q") || "").trim().slice(0, 200);
  const mode = p.get("mode") === "exact" ? "exact" : "smart";
  const sort = ["newest", "oldest"].includes(p.get("sort")) ? p.get("sort") : "relevance";
  const limit = clampInt(p.get("limit"), 1, 50, 20);
  const offset = clampInt(p.get("offset"), 0, 500, 0);
  const speaker = (p.get("speaker") || "").trim().slice(0, 100) || null;
  const year = clampInt(p.get("year"), 1900, 2100, null);
  return { q, mode, sort, limit, offset, speaker, year };
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Run the hybrid search_passages() RPC. */
export async function searchPassages(env, { q, mode, sort, limit, offset, speaker, year }) {
  const semantic = mode === "smart" && sort === "relevance";
  const embedding = semantic ? await embedQuery(env, q) : null;
  const minSim = parseFloat(env.SEMANTIC_MIN_SIMILARITY);
  const results = await supabase(env, "rpc/search_passages", {
    method: "POST",
    body: {
      query_text: q,
      query_embedding: embedding ? JSON.stringify(embedding) : null,
      match_count: limit,
      match_offset: offset,
      sort_by: sort,
      filter_speaker: speaker,
      filter_year: year,
      semantic_weight: semantic ? 1.0 : 0,
      ...(Number.isFinite(minSim) ? { min_similarity: minSim } : {}),
    },
  });
  return { results, semantic: Boolean(embedding) };
}

/** Requests from other sites are rejected for endpoints that cost money. */
export function sameOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // same-origin GETs / curl
  const self = new URL(request.url).origin;
  const allowed = [self, ...(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)];
  return allowed.includes(origin);
}

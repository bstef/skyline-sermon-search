// GET /api/search?q=...&mode=smart|exact&sort=relevance|newest|oldest&speaker=&year=&limit=&offset=
import { json, handleError, readSearchParams, searchPassages } from "../../lib/server.js";

export async function onRequestGet({ request, env, waitUntil }) {
  try {
    const url = new URL(request.url);
    const params = readSearchParams(url);
    if (!params.q) return json({ results: [], semantic: false });

    // Same query → same answer for a few minutes; skips the embedding + DB round trip.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const { results, semantic } = await searchPassages(env, params);
    const res = json({ results, semantic, params }, { maxAge: 300 });
    waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return handleError(err);
  }
}

// Optional meaning search can be enabled by adding a Vectorize binding and a
// server-side OpenAI secret. Keyword search works without either resource.
type SearchEnv = Env & { OPENAI_API_KEY?: string; VECTOR_INDEX?: VectorizeIndex };
type Passage = {
  id: number; episode_id: string; start: number; end: number; text: string;
  title: string; date: string; audio_url: string; speaker: string; speaker_source: string;
};
const MODEL = 'text-embedding-3-small';
const passageColumns = 'p.id,p.episode_id,p.start,p.end,p.text,e.title,e.date,e.audio_url,e.speaker,e.speaker_source';
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function search(db: D1Database, query: string, mode: string, env: SearchEnv) {
  const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 30);
  if (!tokens.length) return { results: [], mode: 'keyword', notice: null };
  const lexical = await db.prepare(`SELECT rowid AS id FROM passages_fts
    WHERE passages_fts MATCH ? ORDER BY bm25(passages_fts) LIMIT 100`)
    .bind(tokens.map(t => `"${t}"`).join(' OR ')).all<{ id: number }>();
  const scores = new Map<number, number>();
  lexical.results.forEach((row, i) => scores.set(row.id, 1 / (61 + i)));
  const semantic = new Map<number, { score: number; fingerprint: string }>();
  let active = 'keyword', notice: string | null = null;
  if (mode === 'smart') {
    const indexed = await db.prepare('SELECT count(*) AS n FROM passages WHERE embedding IS NOT NULL AND model=?')
      .bind(MODEL).first<{ n: number }>();
    if (env.VECTOR_INDEX && env.OPENAI_API_KEY && indexed && indexed.n > 0) {
      try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, dimensions: 512, input: query }),
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Embedding request failed'); }
        const data = await response.json<{ data: { embedding: number[] }[] }>();
        const vector = data.data[0]?.embedding;
        if (!vector || vector.length !== 512 || !vector.every(Number.isFinite)) throw new Error('Invalid embedding');
        const matches = await env.VECTOR_INDEX.query(vector, { topK: 100, returnMetadata: 'none' });
        matches.matches.forEach((hit, i) => {
          const match = /^(\d+)-([a-f0-9]{16})$/.exec(hit.id);
          if (!match) return;
          const id = Number(match[1]);
          if (Number.isSafeInteger(id) && hit.score >= .3) semantic.set(id, {score: 1 / (61 + i), fingerprint: match[2]});
        });
        active = 'hybrid';
      } catch {
        notice = 'Meaning search is temporarily unavailable. Showing keyword matches.';
      }
    } else notice = 'Showing keyword matches. Meaning search needs indexed embeddings and a server API key.';
  }
  const ids = [...new Set([...scores.keys(), ...semantic.keys()])];
  if (!ids.length) return { results: [], mode: active, notice };
  // D1 allows at most 100 bound parameters per statement.
  const statements = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    statements.push(db.prepare(`SELECT ${passageColumns} FROM passages p
      JOIN episodes e ON e.id=p.episode_id WHERE p.id IN (${batch.map(() => '?').join(',')})`).bind(...batch));
  }
  const batches = await db.batch<Passage>(statements);
  const rows = { results: batches.flatMap(b => b.results) };
  // A replaced transcript can reuse a passage ID. Reject old vectors whose
  // content fingerprint no longer matches the current D1 passage.
  for (const row of rows.results) {
    const hit = semantic.get(row.id);
    if (!hit) continue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.text));
    const fingerprint = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
    if (fingerprint === hit.fingerprint) scores.set(row.id, (scores.get(row.id) ?? 0) + hit.score);
  }
  rows.results = rows.results.filter(row => scores.has(row.id));
  rows.results.sort((a,b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  const results: Passage[] = [];
  for (const row of rows.results) {
    if (results.some(r => r.episode_id === row.episode_id && Math.max(r.start,row.start) < Math.min(r.end,row.end))) continue;
    results.push(row);
    if (results.length === 20) break;
  }
  return { results, mode: active, notice };
}
export default {
  async fetch(request: Request, env: SearchEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!['GET','HEAD'].includes(request.method)) return json({ error: 'Method not allowed' },405);
    try {
      if (url.pathname === '/api/episodes') {
        const rows = await env.DB.prepare(`SELECT e.*,COUNT(p.id) AS passages FROM episodes e
          LEFT JOIN passages p ON p.episode_id=e.id GROUP BY e.id ORDER BY e.date DESC`).all();
        return json(rows.results);
      }
      if (url.pathname === '/api/stats') {
        return json(await env.DB.prepare(`SELECT
          (SELECT count(*) FROM episodes) AS episodes,
          (SELECT count(DISTINCT episode_id) FROM passages) AS indexed,
          (SELECT count(*) FROM passages) AS passages,
          (SELECT count(*) FROM passages WHERE embedding IS NOT NULL AND model=?) AS embedded`)
          .bind(MODEL).first());
      }
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').trim(), mode = url.searchParams.get('mode') ?? 'smart';
        if (!q || q.length > 300 || !['smart','keyword'].includes(mode)) return json({ error: 'Enter a query of 1–300 characters and a valid search mode.' },422);
        const start = performance.now();
        const result = await search(env.DB,q,mode,env);
        return json({ ...result, elapsed_ms: Math.round(performance.now()-start) });
      }
      return json({ error: 'Not found' },404);
    } catch (error) {
      console.error(JSON.stringify({ event: 'api_error', path: url.pathname, message: error instanceof Error ? error.message : 'Unknown error' }));
      return json({ error: 'The sermon database is unavailable. Please try again shortly.' },503);
    }
  }
} satisfies ExportedHandler<SearchEnv>;

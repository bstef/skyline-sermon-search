export type PublishEnv = { DB: D1Database; TRANSCRIPT_PUBLISH_TOKEN?: string };
type Segment = { start: number; end: number; text: string };
type Episode = { id: string; title: string; date: string; audio_url: string; description: string; link: string; speaker: string; speaker_source: string };
const MAX_BYTES = 1024 * 1024;
class Invalid extends Error {}
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Invalid('Expected a JSON object.');
  return value as Record<string, unknown>;
};
function string(value: unknown, name: string, max: number, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new Invalid(`Invalid ${name}.`);
  return value.trim();
}
function https(value: unknown, name: string, optional = false) {
  const text = string(value, name, 2048, optional);
  if (!text && optional) return '';
  try { const url = new URL(text); if (url.protocol === 'https:' && !url.username && !url.password) return text; } catch {}
  throw new Invalid(`${name} must be an HTTPS URL.`);
}
async function body(request: Request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw new Invalid('Payload exceeds 1 MiB.');
  const reader = request.body?.getReader();
  if (!reader) throw new Invalid('Missing request body.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Invalid('Payload exceeds 1 MiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { return record(JSON.parse(new TextDecoder().decode(buffer))); } catch (error) {
    if (error instanceof Invalid) throw error;
    throw new Invalid('Invalid JSON.');
  }
}
async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
function passages(segments: Segment[]) {
  const result: Segment[] = []; let i = 0;
  const counts = segments.map(s => s.text.split(/\s+/).length);
  while (i < segments.length) {
    let j = i + 1, words = counts[i];
    while (j < segments.length && segments[j].end - segments[i].start <= 60 && words + counts[j] <= 220) words += counts[j++];
    result.push({start: segments[i].start, end: segments[j - 1].end, text: segments.slice(i, j).map(s => s.text).join(' ')});
    i = j - i > 1 && j < segments.length ? j - 1 : j;
  }
  return result;
}
export async function publishTranscript(request: Request, env: PublishEnv): Promise<Response> {
  if (request.method !== 'POST') return reply({error: 'Method not allowed'}, 405);
  if (!env.TRANSCRIPT_PUBLISH_TOKEN) return reply({error: 'Publishing is not configured.'}, 503);
  const header = request.headers.get('Authorization') ?? '';
  if (header.length > 512 || !header.startsWith('Bearer ') || !crypto.subtle.timingSafeEqual(await digest(header.slice(7)), await digest(env.TRANSCRIPT_PUBLISH_TOKEN))) {
    return reply({error: 'Unauthorized'}, 401);
  }
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({error: 'Use application/json.'}, 415);
  try {
    const input = await body(request);
    if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') throw new Invalid('dry_run must be a boolean.');
    if (input.sample !== undefined && typeof input.sample !== 'boolean') throw new Invalid('sample must be a boolean.');
    const dryRun = input.dry_run !== false;
    if (input.sample === true && !dryRun) throw new Invalid('Sample transcripts can only be validated in dry run.');
    const e = record(input.episode);
    const episode: Episode = {
      id: string(e.id, 'episode ID', 20), title: string(e.title, 'title', 400), date: string(e.date, 'date', 10),
      audio_url: https(e.audio_url, 'audio_url'), description: string(e.description, 'description', 15000, true),
      link: https(e.link, 'link', true), speaker: string(e.speaker, 'speaker', 200, true), speaker_source: string(e.speaker_source, 'speaker_source', 100, true)
    };
    if (!/^[a-f0-9]{20}$/.test(episode.id)) throw new Invalid('Use the podcast episode ID (20 hexadecimal characters).');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(episode.date) || !Number.isFinite(Date.parse(episode.date)) || new Date(episode.date).toISOString().slice(0, 10) !== episode.date) throw new Invalid('Invalid episode date.');
    if (!Array.isArray(input.segments) || !input.segments.length || input.segments.length > 5000) throw new Invalid('Provide 1–5000 timestamped segments.');
    let previous = -1, total = 0;
    const segments = input.segments.map((value): Segment => {
      const s = record(value), text = string(s.text, 'segment text', 5000);
      if (typeof s.start !== 'number' || typeof s.end !== 'number' || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.start < previous || s.end <= s.start || s.end > 86400) throw new Invalid('Segments must have ordered, finite timestamps within 24 hours.');
      previous = s.start; total += text.length;
      if (total > 500000) throw new Invalid('Transcript text exceeds 500000 characters.');
      return { start: s.start, end: s.end, text };
    });
    const chunks = passages(segments);
    const hash = [...await digest(JSON.stringify({episode, passages: chunks}))].map(n => n.toString(16).padStart(2, '0')).join('');
    const summary = {episode_id: episode.id, title: episode.title, passages: chunks.length, content_hash: hash};
    if (dryRun) return reply({status: 'validated', dry_run: true, ...summary});
    const existing = await env.DB.prepare('SELECT content_hash FROM transcript_publications WHERE episode_id=?').bind(episode.id).first<{content_hash: string}>();
    if (existing?.content_hash === hash) return reply({status: 'already_published', dry_run: false, ...summary});
    // One transaction: an error preserves the prior transcript and its FTS index.
    // Let D1 assign passage IDs; independent LXC row IDs cannot collide here.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO episodes(id,title,date,audio_url,description,link,speaker,speaker_source) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,date=excluded.date,audio_url=excluded.audio_url,
        description=excluded.description,link=excluded.link,speaker=excluded.speaker,speaker_source=excluded.speaker_source`)
        .bind(...Object.values(episode)),
      env.DB.prepare('DELETE FROM passages WHERE episode_id=?').bind(episode.id),
      env.DB.prepare(`INSERT INTO passages(episode_id,start,end,text)
        SELECT ?,json_extract(value,'$.start'),json_extract(value,'$.end'),json_extract(value,'$.text') FROM json_each(?)`)
        .bind(episode.id, JSON.stringify(chunks)),
      env.DB.prepare(`INSERT INTO transcript_publications(episode_id,content_hash,passages,published_at) VALUES(?,?,?,?)
        ON CONFLICT(episode_id) DO UPDATE SET content_hash=excluded.content_hash,passages=excluded.passages,published_at=excluded.published_at`)
        .bind(episode.id, hash, chunks.length, new Date().toISOString())
    ]);
    return reply({status: 'published', dry_run: false, ...summary});
  } catch (error) {
    if (error instanceof Invalid) return reply({error: error.message}, 422);
    console.error(JSON.stringify({event: 'transcript_publish_failed'}));
    return reply({error: 'Publishing failed. Retry this saved transcript.'}, 503);
  }
}

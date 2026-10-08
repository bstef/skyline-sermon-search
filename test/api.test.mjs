// Exercises the Pages Functions against the real schema (PGlite) by routing
// their fetch() calls: Supabase REST → PGlite, Anthropic API → a canned stream.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeDb, search, vec, WORRY } from "./helpers.mjs";
import { onRequestGet as searchGet } from "../functions/api/search.js";
import { onRequestGet as statsGet } from "../functions/api/stats.js";
import { onRequestPost as answerPost } from "../functions/api/answer.js";

const SUPABASE_URL = "https://db.test";
let pg;
let calls;            // every outbound fetch, for assertions
let anthropicReply;   // what the fake Anthropic API streams back

before(async () => {
  pg = await makeDb();
  globalThis.caches = { default: new Map() };
  globalThis.caches.default.match = async (req) => globalThis.caches.default.get(req.url)?.clone();
  globalThis.caches.default.put = async (req, res) => { globalThis.caches.default.set(req.url, res); };
  globalThis.fetch = fakeFetch;
});
beforeEach(() => {
  calls = [];
  globalThis.caches.default.clear();
  anthropicReply = { text: ["Peter asked how often to forgive ", "[1], and the answer was: keep forgiving [2]."], stop: "end_turn" };
});

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const headers = new Headers(init.headers);
  calls.push({ url, body, headers });

  if (url.origin === SUPABASE_URL) {
    assert.equal(headers.get("apikey"), "anon-key");
    if (url.pathname === "/rest/v1/rpc/search_passages") {
      return Response.json(await search(pg, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))));
    }
    if (url.pathname === "/rest/v1/rpc/sermon_stats") {
      return Response.json((await pg.query("select sermon_stats() as s")).rows[0].s);
    }
    if (url.pathname === "/rest/v1/passages") {
      const ids = url.searchParams.get("id").match(/\d+/g).map(Number);
      const { rows } = await pg.query(
        `select p.id, p.start_sec, p.text, json_build_object('title', s.title, 'speaker', s.speaker, 'published_at', s.published_at) as sermons
         from passages p join sermons s on s.id = p.sermon_id where p.id = any($1)`, [ids]);
      return Response.json(rows);
    }
  }
  if (url.hostname === "api.anthropic.com") return sse(anthropicReply);
  throw new Error(`Unexpected fetch: ${url}`);
}

function sse({ text, stop }) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const msg = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  const parts = [
    ev("message_start", { message: msg }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...text.map((t) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }),
    ev("message_stop", {}),
  ];
  return new Response(parts.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

const env = (extra = {}) => ({
  SUPABASE_URL, SUPABASE_ANON_KEY: "anon-key",
  AI: { calls: 0, async run(model, { text }) { this.calls++; assert.equal(model, "@cf/baai/bge-base-en-v1.5"); assert.deepEqual(text, ["anxiety"]); return { data: [JSON.parse(vec(WORRY))] }; } },
  ...extra,
});
const ctx = (url, e = env(), init) => ({ request: new Request(url, init), env: e, waitUntil: (p) => p });

test("search: smart mode embeds the query and finds passages by meaning", async () => {
  const e = env();
  const res = await searchGet(ctx("https://site.test/api/search?q=anxiety", e));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Cache-Control"), /max-age=300/);
  const data = await res.json();
  assert.equal(data.semantic, true);
  assert.equal(e.AI.calls, 1);
  assert.ok(data.results.length >= 2);
  assert.equal(data.results[0].title, "Do Not Worry");
  assert.equal(data.results[0].keyword_match, false);
  assert.ok(data.results[0].audio_url.endsWith("s1.mp3"));
});

test("search: identical requests are served from the edge cache", async () => {
  const e = env();
  await searchGet(ctx("https://site.test/api/search?q=anxiety", e));
  const again = await searchGet(ctx("https://site.test/api/search?q=anxiety", e));
  assert.equal(again.status, 200);
  assert.equal(e.AI.calls, 1, "second request didn't re-embed");
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("search_passages")).length, 1);
});

test("search: exact mode and date sorts skip the embedding", async () => {
  for (const qs of ["mode=exact", "sort=newest", "sort=oldest"]) {
    const e = env();
    const data = await (await searchGet(ctx(`https://site.test/api/search?q=anxiety&${qs}`, e))).json();
    assert.equal(e.AI.calls, 0, qs);
    assert.equal(data.semantic, false, qs);
    assert.equal(data.results.length, 0, `${qs}: "anxiety" isn't literally in any passage`);
  }
});

test("search: works keyword-only when Workers AI isn't bound or fails", async () => {
  const noAi = await (await searchGet(ctx("https://site.test/api/search?q=birds", env({ AI: undefined })))).json();
  assert.equal(noAi.semantic, false);
  assert.equal(noAi.results.length, 1);
  const broken = env({ AI: { run: async () => { throw new Error("quota"); } } });
  const r = await (await searchGet(ctx("https://site.test/api/search?q=birds", broken))).json();
  assert.equal(r.results.length, 1);
});

test("search: clamps parameters and passes filters through", async () => {
  await searchGet(ctx("https://site.test/api/search?q=seed&limit=999&offset=-5&year=2024&speaker=Jane%20Doe&sort=bogus&mode=exact", env()));
  const rpc = calls.find((c) => c.url.pathname.endsWith("search_passages")).body;
  assert.equal(rpc.match_count, 50);
  assert.equal(rpc.match_offset, 0);
  assert.equal(rpc.filter_year, 2024);
  assert.equal(rpc.filter_speaker, "Jane Doe");
  assert.equal(rpc.sort_by, "relevance");
  assert.equal(rpc.semantic_weight, 0);
});

test("search: empty query returns nothing without touching the database", async () => {
  const data = await (await searchGet(ctx("https://site.test/api/search?q=%20%20", env()))).json();
  assert.deepEqual(data.results, []);
  assert.equal(calls.length, 0);
});

test("search: a missing Supabase config is a clear 500", async () => {
  const res = await searchGet(ctx("https://site.test/api/search?q=x", { }));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /SUPABASE_URL/);
});

test("stats: reports archive numbers and whether summaries are on", async () => {
  const off = await (await statsGet({ env: env() })).json();
  assert.equal(off.transcribed, 3);
  assert.equal(off.answers_enabled, false);
  const on = await (await statsGet({ env: env({ ANTHROPIC_API_KEY: "k" }) })).json();
  assert.equal(on.answers_enabled, true);
});

async function readNdjson(res) {
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}
const post = (body, { origin = "https://site.test", e = env({ ANTHROPIC_API_KEY: "test-key" }) } = {}) =>
  answerPost(ctx("https://site.test/api/answer", e, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  }));

async function passageIds(...startSecs) {
  const { rows } = await pg.query("select id, start_sec from passages");
  return startSecs.map((s) => rows.find((r) => r.start_sec === s).id);
}

test("answer: streams a cited summary built from database text", async () => {
  const ids = await passageIds(30, 95);
  const res = await post({ q: "how often should I forgive?", ids });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /ndjson/);
  const events = await readNdjson(res);
  assert.equal(events.map((e) => e.t || "").join(""), anthropicReply.text.join(""));
  assert.deepEqual(events.at(-1), { done: true });

  const req = calls.find((c) => c.url.hostname === "api.anthropic.com");
  assert.equal(req.headers.get("x-api-key"), "test-key");
  assert.match(req.headers.get("anthropic-beta"), /server-side-fallback-2026-07-01/);
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.fallbacks, "default");
  assert.deepEqual(req.body.output_config, { effort: "low" });
  assert.equal(req.body.stream, true);
  assert.equal(req.body.betas, undefined, "betas go in the header, not the body");
  const prompt = req.body.messages[0].content;
  assert.match(prompt, /Question: how often should I forgive\?/);
  assert.match(prompt, /\[1\] "Seventy Times Seven" — Pastor Chris, 2023-06-11, at 0:30\nPeter asks/);
  assert.match(prompt, /\[2\] "Seventy Times Seven" — Pastor Chris, 2023-06-11, at 1:35\nThe servant/);
});

test("answer: honors ANSWER_MODEL", async () => {
  await readNdjson(await post({ q: "x", ids: await passageIds(30) }, { e: env({ ANTHROPIC_API_KEY: "k", ANSWER_MODEL: "claude-haiku-5-5" }) }));
  assert.equal(calls.find((c) => c.url.hostname === "api.anthropic.com").body.model, "claude-haiku-5-5");
});

test("answer: a refusal becomes a friendly error event", async () => {
  anthropicReply = { text: [], stop: "refusal" };
  const events = await readNdjson(await post({ q: "x", ids: await passageIds(30) }));
  assert.match(events.at(-1).error, /couldn't summarize/);
});

test("answer: guarded by key, origin, and input checks", async () => {
  const ids = await passageIds(30);
  assert.equal((await post({ q: "x", ids }, { e: env() })).status, 404, "no ANTHROPIC_API_KEY → off");
  assert.equal((await post({ q: "x", ids }, { origin: "https://evil.test" })).status, 403);
  assert.equal((await post({ q: "x", ids }, { origin: null })).status, 403);
  assert.equal((await post({ q: "", ids })).status, 400);
  assert.equal((await post({ q: "x", ids: [] })).status, 400);
  assert.equal((await post({ q: "x", ids: [999999] })).status, 404);
  assert.equal(calls.filter((c) => c.url.hostname === "api.anthropic.com").length, 0);
});

test("answer: only the first 8 ids are used", async () => {
  const { rows } = await pg.query("select id from passages order by id");
  const ids = [...rows.map((r) => r.id), ...rows.map((r) => r.id)]; // 14 ids
  await readNdjson(await post({ q: "x", ids }));
  const req = calls.find((c) => c.url.pathname === "/rest/v1/passages");
  assert.equal(req.url.searchParams.get("id").match(/\d+/g).length, 8);
});

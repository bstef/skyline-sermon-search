// Runs db/schema.sql in PGlite (Postgres compiled to WASM, with pgvector) and
// exercises the real search_passages() function.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeDb, search, vec, WORRY, FORGIVE, KINGDOM } from "./helpers.mjs";

let pg;
before(async () => { pg = await makeDb(); });

test("keyword search stems words and highlights matches", async () => {
  const rows = await search(pg, { query_text: "forgive" });
  // "forgive" and "forgiveness" share a stem; Snowball leaves "forgiven" alone,
  // so passage 2 is only reachable by meaning (see the semantic tests).
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Seventy Times Seven");
  assert.ok(rows[0].keyword_match);
  assert.match(rows[0].snippet, /\[\[forgive\]\]/);
  assert.match(rows[0].snippet, /\[\[Forgiveness\]\]/);
  const smart = await search(pg, { query_text: "forgive", query_embedding: vec(FORGIVE) });
  assert.deepEqual(smart.slice(0, 2).map((r) => r.start_sec), [30, 95], "smart mode picks up 'forgiven' too");
  assert.deepEqual(smart.slice(0, 2).map((r) => r.keyword_match), [true, false]);
});

test("quoted phrases match the exact phrase only", async () => {
  const rows = await search(pg, { query_text: '"mustard seed"' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].start_sec, 20);
  const loose = await search(pg, { query_text: "mustard seed" });
  assert.equal(loose.length, 2, "without quotes, both mustard passages match");
});

test("semantic search finds passages by meaning with no shared words", async () => {
  // "anxiety" appears nowhere; only the embedding links it to the worry passages.
  const rows = await search(pg, { query_text: "anxiety", query_embedding: vec(WORRY) });
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].title, "Do Not Worry");
  assert.equal(rows[1].title, "Do Not Worry");
  assert.ok(rows.every((r) => !r.keyword_match));
  assert.ok(rows[0].similarity > 0.95);
  assert.ok(!rows.some((r) => r.start_sec === 140), "unrelated passages fall below min_similarity");
});

test("hybrid ranking puts keyword+meaning matches first", async () => {
  // "anxious" matches passage s1/0 by keyword AND by meaning; s1/1 by meaning only.
  const rows = await search(pg, { query_text: "anxious", query_embedding: vec(WORRY) });
  assert.equal(rows[0].start_sec, 10);
  assert.ok(rows[0].keyword_match);
  assert.ok(rows[0].score > rows[1].score);
});

test("semantic weight 0 / no embedding means keyword-only", async () => {
  const rows = await search(pg, { query_text: "anxiety", query_embedding: vec(WORRY), semantic_weight: 0 });
  assert.equal(rows.length, 0);
});

test("date sorting returns keyword matches in date order", async () => {
  const newest = await search(pg, { query_text: "seed OR forgive OR birds", query_embedding: vec(WORRY), sort_by: "newest" });
  assert.ok(newest.every((r) => r.keyword_match), "semantic-only hits excluded when sorting by date");
  const dates = newest.map((r) => r.published_at.getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  const oldest = await search(pg, { query_text: "seed OR forgive OR birds", sort_by: "oldest" });
  assert.equal(oldest[0].title, "Do Not Worry");
});

test("speaker and year filters", async () => {
  const bySpeaker = await search(pg, { query_text: "seed OR forgive", filter_speaker: "Jane Doe" });
  assert.ok(bySpeaker.length && bySpeaker.every((r) => r.speaker === "Jane Doe"));
  const byYear = await search(pg, { query_text: "seed OR forgive", filter_year: 2023 });
  assert.ok(byYear.length && byYear.every((r) => r.published_at.getUTCFullYear() === 2023));
});

test("pagination with match_count/match_offset", async () => {
  const all = await search(pg, { query_text: "the", query_embedding: vec(KINGDOM), min_similarity: -1 });
  const page1 = await search(pg, { query_text: "the", query_embedding: vec(KINGDOM), min_similarity: -1, match_count: 3 });
  const page2 = await search(pg, { query_text: "the", query_embedding: vec(KINGDOM), min_similarity: -1, match_count: 3, match_offset: 3 });
  assert.equal(page1.length, 3);
  assert.deepEqual([...page1, ...page2].map((r) => r.passage_id), all.slice(0, page1.length + page2.length).map((r) => r.passage_id));
});

test("stop-word-only and empty queries don't error", async () => {
  assert.equal((await search(pg, { query_text: "" })).length, 0);
  assert.equal((await search(pg, { query_text: "the and of" })).length, 0);
});

test("sermon_stats summarizes transcribed sermons only", async () => {
  const { rows: [{ sermon_stats: s }] } = await pg.query("select sermon_stats()");
  assert.equal(s.sermons, 4);
  assert.equal(s.transcribed, 3);
  assert.deepEqual(s.years, [2024, 2023, 2021]);
  assert.deepEqual(s.speakers, [{ speaker: "Pastor Chris", count: 2 }, { speaker: "Jane Doe", count: 1 }]);
});

test("anon can read but not write (RLS)", async () => {
  // Mirror Supabase's default table grants to anon, so only RLS stands in the way.
  await pg.exec(`grant usage on schema public, extensions to anon;
                 grant select, insert, update, delete on all tables in schema public to anon;`);
  await pg.exec("set role anon");
  try {
    const { rows } = await pg.query("select count(*)::int as n from passages");
    assert.equal(rows[0].n, 7);
    assert.ok((await search(pg, { query_text: "forgive" })).length > 0, "anon can run the search RPC");
    await assert.rejects(pg.query("insert into sermons (guid, title, audio_url) values ('x','x','x')"), /row-level security/);
    const del = await pg.query("delete from passages");
    assert.equal(del.affectedRows, 0);
    const upd = await pg.query("update sermons set title = 'hacked'");
    assert.equal(upd.affectedRows, 0);
  } finally {
    await pg.exec("reset role");
  }
});

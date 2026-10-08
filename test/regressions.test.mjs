// Regression tests for review findings, each on its own fresh database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb, search, vec, FORGIVE } from "./helpers.mjs";

test("date sort finds the newest match even when >2000 passages match", async () => {
  const pg = await makeDb();
  // 2,100 strongly-ranked matches in an old sermon…
  await pg.exec(`
    insert into sermons (guid, title, published_at, audio_url, transcript_status)
    values ('old', 'Old Grace', '2010-01-03T14:00:00Z', 'https://cdn.test/old.mp3', 'done');
    insert into passages (sermon_id, idx, start_sec, end_sec, text)
    select (select id from sermons where guid = 'old'), g, g * 60, g * 60 + 60, 'grace grace grace upon grace'
    from generate_series(0, 2099) g;
  `);
  // …and one weak match in the newest sermon.
  await pg.exec(`
    insert into sermons (guid, title, published_at, audio_url, transcript_status)
    values ('new', 'Newest Sermon', '2026-09-27T14:00:00Z', 'https://cdn.test/new.mp3', 'done');
    insert into passages (sermon_id, idx, start_sec, end_sec, text)
    values ((select id from sermons where guid = 'new'), 0, 600, 660,
            'We talked about many things this morning, among them the idea of grace, and then we prayed together for the city.');
  `);
  const newest = await search(pg, { query_text: "grace", sort_by: "newest", match_count: 5 });
  assert.equal(newest[0].title, "Newest Sermon");
  const oldest = await search(pg, { query_text: "grace", sort_by: "oldest", match_count: 5 });
  assert.equal(oldest[0].title, "Old Grace");
  const page2 = await search(pg, { query_text: "grace", sort_by: "newest", match_count: 5, match_offset: 1 });
  assert.equal(page2.length, 5);
  assert.ok(page2.every((r) => r.title === "Old Grace"));
});

test("replace_passages swaps a sermon's passages atomically", async () => {
  const pg = await makeDb();
  const { rows: [{ id }] } = await pg.query("select id from sermons where guid = 's2'");
  const count = async () => (await pg.query("select count(*)::int n from passages where sermon_id = $1", [id])).rows[0].n;
  assert.equal(await count(), 2);

  const good = [
    { idx: 0, start_sec: 1, end_sec: 50, text: "New first passage about forgiveness.", embedding: vec(FORGIVE) },
    { idx: 1, start_sec: 50, end_sec: 99, text: "New second passage.", embedding: null },
    { idx: 2, start_sec: 99, end_sec: 140, text: "New third passage.", embedding: vec(FORGIVE) },
  ];
  const { rows: [{ replace_passages: n }] } = await pg.query("select replace_passages($1, $2::jsonb)", [id, JSON.stringify(good)]);
  assert.equal(n, 3);
  assert.equal(await count(), 3);
  const { rows } = await pg.query("select idx, text, embedding is not null as has_emb from passages where sermon_id = $1 order by idx", [id]);
  assert.deepEqual(rows.map((r) => [r.idx, r.has_emb]), [[0, true], [1, false], [2, true]]);
  assert.ok((await search(pg, { query_text: "forgiveness" })).some((r) => r.start_sec === 1), "new passages are searchable");

  // A bad row (missing text) must leave the previous passages untouched.
  const bad = [good[0], { idx: 1, start_sec: 50, end_sec: 99, text: null, embedding: null }];
  await assert.rejects(pg.query("select replace_passages($1, $2::jsonb)", [id, JSON.stringify(bad)]));
  assert.equal(await count(), 3);
});

test("anon cannot call replace_passages", async () => {
  const pg = await makeDb();
  await pg.exec(`grant usage on schema public, extensions to anon;
                 grant select, insert, update, delete on all tables in schema public to anon;`);
  await pg.exec("set role anon");
  try {
    await assert.rejects(pg.query("select replace_passages(1, '[]'::jsonb)"), /permission denied/);
  } finally {
    await pg.exec("reset role");
  }
});

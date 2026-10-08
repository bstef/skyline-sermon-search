// Shared test fixtures: a PGlite database loaded with db/schema.sql and a few fake sermons.
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

export const DIM = 768;
/** A unit vector pointing mostly along `axis`, a little along `mix` (deterministic). */
export function vec(axis, mix = null, mixWeight = 0) {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  if (mix != null) v[mix] = mixWeight;
  const norm = Math.hypot(...v);
  return JSON.stringify(v.map((x) => x / norm));
}
// "Topics" for fake embeddings.
export const WORRY = 0, FORGIVE = 1, KINGDOM = 2, OTHER = 3;

export async function makeDb() {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec("create role anon; create role authenticated;");
  await pg.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  // Re-running the schema must be safe.
  await pg.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));

  const sermons = [
    // guid, title, speaker, date, status
    ["s1", "Do Not Worry", "Pastor Chris", "2021-03-07", "done"],
    ["s2", "Seventy Times Seven", "Pastor Chris", "2023-06-11", "done"],
    ["s3", "Small Beginnings", "Jane Doe", "2024-09-15", "done"],
    ["s4", "Not yet transcribed", "Pastor Chris", "2025-01-05", "pending"],
  ];
  for (const [guid, title, speaker, date, status] of sermons) {
    await pg.query(
      `insert into sermons (guid, title, speaker, published_at, audio_url, transcript_status)
       values ($1, $2, $3, $4, $5, $6)`,
      [guid, title, speaker, date + "T14:00:00Z", `https://cdn.example.com/${guid}.mp3`, status],
    );
  }
  const id = async (guid) => (await pg.query("select id from sermons where guid = $1", [guid])).rows[0].id;
  const passages = [
    // sermon, idx, start, text, embedding
    ["s1", 0, 10, "Jesus says look at the birds of the air. Your Father feeds them. Can any of you add a single hour to your life by being anxious?", vec(WORRY)],
    ["s1", 1, 75, "When the bills pile up and the diagnosis comes back, bring it to God in prayer before you bring it to your group chat.", vec(WORRY, OTHER, 0.3)],
    ["s2", 0, 30, "Peter asks how many times shall I forgive my brother. Forgiveness is not a feeling, it is a decision you make again and again.", vec(FORGIVE)],
    ["s2", 1, 95, "The servant was forgiven a debt he could never repay, and then he choked a man over a few dollars.", vec(FORGIVE, WORRY, 0.2)],
    ["s3", 0, 20, "The kingdom of heaven is like a mustard seed, the smallest of all seeds, yet it grows into a tree.", vec(KINGDOM)],
    ["s3", 1, 80, "Don't despise the seed you planted. Mustard grows slowly. Small faithfulness compounds over years.", vec(KINGDOM, FORGIVE, 0.1)],
    ["s3", 2, 140, "Announcements: the picnic is next Saturday and sign-ups are in the lobby.", vec(OTHER)],
  ];
  for (const [guid, idx, start, text, emb] of passages) {
    await pg.query(
      `insert into passages (sermon_id, idx, start_sec, end_sec, text, embedding) values ($1, $2, $3, $4, $5, $6)`,
      [await id(guid), idx, start, start + 60, text, emb],
    );
  }
  return pg;
}

/** Call search_passages with named args, the same way PostgREST does. */
export async function search(pg, args) {
  const names = Object.keys(args);
  const sql = `select * from search_passages(${names.map((n, i) =>
    `${n} => $${i + 1}${n === "query_embedding" ? "::extensions.vector" : ""}`).join(", ")})`;
  return (await pg.query(sql, names.map((n) => args[n]))).rows;
}


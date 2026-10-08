#!/usr/bin/env node
// Sermon ingest: podcast RSS → Deepgram transcript → passages → embeddings → Supabase.
//
//   node ingest/ingest.mjs --dry-run            list what the feed contains, change nothing
//   node ingest/ingest.mjs --limit 5            sync the feed, transcribe up to 5 new sermons
//   node ingest/ingest.mjs --guid <guid>        (re)transcribe one specific episode
//   node ingest/ingest.mjs --retry-errors       also retry episodes that failed before
//   node ingest/ingest.mjs --rechunk            re-split + re-embed every transcribed sermon
//                                               from its stored sentences (no Deepgram cost)
//
// Environment (see README → "Ingest"):
//   FEED_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEEPGRAM_API_KEY,
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
//   optional: DEFAULT_SPEAKER, SERIES_PATTERN, DEEPGRAM_KEYTERMS, DEEPGRAM_MODEL

import { parseArgs } from "node:util";
import {
  parseFeed, deepgramToSentences, chunkSentences, packSentences, unpackSentences,
} from "./lib.mjs";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_BATCH = 50;

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string", default: "5" },
    guid: { type: "string" },
    "retry-errors": { type: "boolean", default: false },
    rechunk: { type: "boolean", default: false },
  },
});

const env = process.env;
function need(...names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    console.error(`Missing environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ── Supabase (PostgREST over fetch, service role) ─────────────────────────

async function db(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Deepgram ──────────────────────────────────────────────────────────────

function deepgramUrl() {
  const p = new URLSearchParams({
    model: env.DEEPGRAM_MODEL || "nova-3",
    language: "en",
    smart_format: "true",
    punctuate: "true",
    paragraphs: "true",
  });
  // Names and words the model should get right ("Skyline", the pastors' names…)
  for (const term of (env.DEEPGRAM_KEYTERMS || "").split(",").map((t) => t.trim()).filter(Boolean)) {
    p.append("keyterm", term);
  }
  return `https://api.deepgram.com/v1/listen?${p}`;
}

async function transcribe(audioUrl) {
  const headers = { Authorization: `Token ${env.DEEPGRAM_API_KEY}` };
  // First choice: hand Deepgram the URL and let it fetch the audio itself.
  let res = await fetch(deepgramUrl(), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ url: audioUrl }),
  });
  if (!res.ok) {
    // Some podcast hosts/trackers block Deepgram's fetcher — download and upload instead.
    const firstError = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    console.log(`    URL mode failed (${firstError}); uploading the audio instead`);
    const audio = await fetch(audioUrl, { redirect: "follow" });
    if (!audio.ok) throw new Error(`Couldn't download audio (${audio.status})`);
    res = await fetch(deepgramUrl(), {
      method: "POST",
      headers: { ...headers, "Content-Type": audio.headers.get("content-type") || "audio/mpeg" },
      body: Buffer.from(await audio.arrayBuffer()),
    });
    if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const json = await res.json();
  return {
    sentences: deepgramToSentences(json),
    duration: Math.round(json?.metadata?.duration || 0) || null,
  };
}

// ── Embeddings (Cloudflare Workers AI — same model the search API uses) ───

async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${EMBED_MODEL}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: batch }),
      },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      throw new Error(`Workers AI ${res.status}: ${JSON.stringify(json?.errors || json).slice(0, 500)}`);
    }
    out.push(...json.result.data);
  }
  return out;
}

// ── Pipeline ──────────────────────────────────────────────────────────────

async function writePassages(sermonId, sentences) {
  const chunks = chunkSentences(sentences);
  const vectors = await embed(chunks.map((c) => c.text));
  await db(`passages?sermon_id=eq.${sermonId}`, { method: "DELETE" });
  const rows = chunks.map((c, i) => ({
    sermon_id: sermonId,
    idx: c.idx,
    start_sec: c.start_sec,
    end_sec: c.end_sec,
    text: c.text,
    embedding: JSON.stringify(vectors[i]),
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await db("passages", { method: "POST", body: rows.slice(i, i + 200), prefer: "return=minimal" });
  }
  return chunks.length;
}

async function processSermon(s) {
  console.log(`  • ${s.published_at?.slice(0, 10) || "????-??-??"}  ${s.title}`);
  await db(`sermons?id=eq.${s.id}`, {
    method: "PATCH", body: { transcript_status: "processing", transcript_error: null }, prefer: "return=minimal",
  });
  try {
    const t0 = Date.now();
    const { sentences, duration } = await transcribe(s.audio_url);
    if (!sentences.length) throw new Error("Transcript came back empty");
    const n = await writePassages(s.id, sentences);
    await db(`sermons?id=eq.${s.id}`, {
      method: "PATCH",
      body: {
        transcript_status: "done",
        transcribed_at: new Date().toISOString(),
        sentences: packSentences(sentences),
        ...(duration ? { duration_sec: duration } : {}),
      },
      prefer: "return=minimal",
    });
    console.log(`    ✓ ${sentences.length} sentences → ${n} passages (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return true;
  } catch (err) {
    console.error(`    ✗ ${err.message}`);
    await db(`sermons?id=eq.${s.id}`, {
      method: "PATCH", body: { transcript_status: "error", transcript_error: String(err.message).slice(0, 1000) },
      prefer: "return=minimal",
    });
    return false;
  }
}

async function main() {
  if (args.rechunk) {
    need("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN");
    const done = await db("sermons?select=id,title,sentences&transcript_status=eq.done&order=published_at.desc");
    console.log(`Re-chunking ${done.length} sermon(s) from stored sentences…`);
    for (const s of done) {
      const n = await writePassages(s.id, unpackSentences(s.sentences));
      console.log(`  • ${s.title} → ${n} passages`);
    }
    return;
  }

  need("FEED_URL");
  console.log(`Fetching feed ${env.FEED_URL}`);
  const feedRes = await fetch(env.FEED_URL, { headers: { "User-Agent": "SkylineSermonSearch/1.0" } });
  if (!feedRes.ok) throw new Error(`Feed fetch failed: ${feedRes.status}`);
  const episodes = parseFeed(await feedRes.text(), {
    defaultSpeaker: env.DEFAULT_SPEAKER || null,
    seriesPattern: env.SERIES_PATTERN || null,
  });
  console.log(`Feed has ${episodes.length} audio episode(s).`);

  if (args["dry-run"]) {
    for (const e of episodes) {
      console.log(`  ${e.published_at?.slice(0, 10) || "????-??-??"}  ${e.title}  [${e.speaker || "no speaker"}${e.series ? ` · ${e.series}` : ""}]`);
    }
    return;
  }

  need("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEEPGRAM_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN");

  // Insert episodes we haven't seen; leave existing rows alone so any manual
  // fixes in Supabase (speaker names, series) survive. New rows start 'pending'.
  for (let i = 0; i < episodes.length; i += 200) {
    await db("sermons?on_conflict=guid", {
      method: "POST",
      body: episodes.slice(i, i + 200),
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  }

  const limit = Math.max(1, parseInt(args.limit, 10) || 5);
  const select = "select=id,guid,title,audio_url,published_at";
  let queue;
  if (args.guid) {
    queue = await db(`sermons?${select}&guid=eq.${encodeURIComponent(args.guid)}`);
  } else {
    const statuses = args["retry-errors"] ? "(pending,error,processing)" : "(pending)";
    queue = await db(`sermons?${select}&transcript_status=in.${statuses}&order=published_at.desc.nullslast&limit=${limit}`);
  }

  if (!queue.length) {
    console.log("Nothing new to transcribe.");
    return;
  }
  console.log(`Transcribing ${queue.length} sermon(s):`);
  let failed = 0;
  for (const s of queue) if (!(await processSermon(s))) failed++;
  console.log(`Done. ${queue.length - failed} succeeded, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

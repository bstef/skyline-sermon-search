// POST /api/answer  { q: "question", ids: [passage ids shown on screen, max 8] }
//
// Streams a short, cited summary of what the given passages say about the
// question, as newline-delimited JSON:
//   {"t": "text delta"} … then {"done": true}  (or {"error": "..."})
//
// The browser sends the passage IDs it's already showing so the [1], [2]
// citations line up with the results on screen; the passage text itself is
// re-read from the database rather than trusted from the request.
//
// Off unless ANTHROPIC_API_KEY is set.

import Anthropic from "@anthropic-ai/sdk";
import { json, handleError, supabase, sameOrigin, HttpError } from "../../lib/server.js";

const MAX_PASSAGES = 8;

const SYSTEM = `You help people find what was preached at Skyline Church (Bloomfield, NJ). \
You are given a question and numbered excerpts from automatically transcribed sermons.

Answer using only those excerpts:
- Summarize what was said, citing excerpts inline like [1] or [2][4]. Every claim needs a citation.
- Mention which sermon and roughly when, where it helps ("In a 2023 sermon on prayer, [3] ...").
- Quote short phrases exactly as transcribed; never invent or "fix" a quote.
- If the excerpts don't really address the question, say so in one sentence and suggest a different search.
- Don't add outside theology or your own opinions; you're reporting what the sermons said.
- Keep it under 150 words. Plain text only — no headings, bullet lists, or markdown.
- Transcripts are automatic, so a word may occasionally be wrong; don't call attention to it unless it matters.

Latency-sensitive; begin your visible answer immediately.`;

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ANTHROPIC_API_KEY) throw new HttpError(404, "AI summaries aren't enabled on this site.");
    if (!request.headers.get("Origin") || !sameOrigin(request, env)) throw new HttpError(403, "Forbidden");

    const body = await request.json().catch(() => ({}));
    const q = String(body.q || "").trim().slice(0, 300);
    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .map((n) => parseInt(n, 10)).filter(Number.isFinite).slice(0, MAX_PASSAGES);
    if (!q || !ids.length) throw new HttpError(400, "Send a question and the passage ids to summarize.");

    const rows = await supabase(env,
      `passages?select=id,start_sec,text,sermons(title,speaker,published_at)&id=in.(${ids.join(",")})`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const excerpts = ids.map((id, i) => {
      const r = byId.get(id);
      if (!r) return null;
      const s = r.sermons || {};
      const date = s.published_at ? s.published_at.slice(0, 10) : "date unknown";
      return `[${i + 1}] "${s.title}" — ${s.speaker || "speaker unknown"}, ${date}, at ${fmtTime(r.start_sec)}\n${r.text}`;
    }).filter(Boolean);
    if (!excerpts.length) throw new HttpError(404, "Those passages weren't found.");

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const stream = client.beta.messages.stream({
      model: env.ANSWER_MODEL || "claude-opus-5-5",
      max_tokens: 2048,
      output_config: { effort: "low" },
      // If a safety classifier declines, retry on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Question: ${q}\n\nExcerpts:\n\n${excerpts.join("\n\n")}`,
      }],
    });

    const enc = new TextEncoder();
    const out = new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        try {
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              send({ t: event.delta.text });
            }
          }
          const final = await stream.finalMessage();
          if (final.stop_reason === "refusal") {
            send({ error: "The assistant couldn't summarize this one. The results below are still accurate." });
          } else {
            send({ done: true });
          }
        } catch (err) {
          console.error(err);
          send({ error: "The summary failed to load. The results below are unaffected." });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(out, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return handleError(err);
  }
}

export function onRequestGet() {
  return json({ error: "Use POST" }, { status: 405 });
}

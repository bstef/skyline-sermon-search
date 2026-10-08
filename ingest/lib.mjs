// Pure helpers for the ingest job — no network, no dependencies, unit-tested
// in test/lib.test.mjs.

// ── RSS ───────────────────────────────────────────────────────────────────

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeXml(s) {
  if (s == null) return s;
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

export function stripHtml(s) {
  if (!s) return s;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m) => decodeXml(m))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tag(xml, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = xml.match(re);
  return m ? decodeXml(m[1]) : null;
}

function attr(xml, name, attribute) {
  const re = new RegExp(`<${name}\\s[^>]*?${attribute}\\s*=\\s*["']([^"']*)["'][^>]*>`, "i");
  const m = xml.match(re);
  return m ? decodeXml(m[1]) : null;
}

/** "1:02:03", "62:03", "3723" → seconds */
export function parseDuration(s) {
  if (s == null || s === "") return null;
  const parts = String(s).trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0));
}

const TITLE_SPEAKER = /\b(?:Pastor|Ps\.|Rev\.?|Reverend|Dr\.?|Bishop|Elder)\s+([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)?)/;

/**
 * Best-effort speaker detection, in order:
 *   1. an item-level <itunes:author> that differs from the show's author
 *      (many church feeds put the church name on every episode — useless)
 *   2. "Pastor Firstname Lastname"-style text in the title, then description
 *   3. the fallback (DEFAULT_SPEAKER), else null
 */
export function detectSpeaker({ itemAuthor, channelAuthor, title, description }, fallback = null) {
  if (itemAuthor && itemAuthor !== channelAuthor) return itemAuthor;
  for (const text of [title, description]) {
    const m = text && text.match(TITLE_SPEAKER);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return fallback || null;
}

/** Parse a podcast RSS feed into plain episode objects (newest first, as in the feed). */
export function parseFeed(xml, { defaultSpeaker = null, seriesPattern = null } = {}) {
  const channelHead = xml.split(/<item[\s>]/i)[0];
  const channelAuthor = tag(channelHead, "itunes:author");
  const channelImage = attr(channelHead, "itunes:image", "href") || tag(tag(channelHead, "image") || "", "url");
  const seriesRe = seriesPattern ? new RegExp(seriesPattern, "i") : null;

  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = m[0];
    const audioUrl = attr(item, "enclosure", "url");
    if (!audioUrl) continue; // not an audio episode
    const title = stripHtml(tag(item, "title")) || "Untitled";
    const description = stripHtml(tag(item, "itunes:summary") || tag(item, "description") || tag(item, "content:encoded"));
    const pub = tag(item, "pubDate");
    const date = pub ? new Date(pub) : null;
    let series = null;
    if (seriesRe) {
      const sm = title.match(seriesRe) || (description || "").match(seriesRe);
      series = sm ? (sm[1] || sm[0]).trim() : null;
    }
    items.push({
      guid: tag(item, "guid") || audioUrl,
      title,
      description,
      speaker: detectSpeaker(
        { itemAuthor: tag(item, "itunes:author"), channelAuthor, title, description },
        defaultSpeaker,
      ),
      series,
      published_at: date && !isNaN(date) ? date.toISOString() : null,
      audio_url: audioUrl,
      episode_url: tag(item, "link"),
      image_url: attr(item, "itunes:image", "href") || channelImage || null,
      duration_sec: parseDuration(tag(item, "itunes:duration")),
    });
  }
  return items;
}

// ── Transcripts ───────────────────────────────────────────────────────────

/**
 * Normalize a Deepgram pre-recorded response into sentences
 * [{start, end, text}]. Prefers Deepgram's paragraphs/sentences output
 * (paragraphs=true); falls back to grouping words on end punctuation.
 */
export function deepgramToSentences(dg) {
  const alt = dg?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) return [];
  const paragraphs = alt.paragraphs?.paragraphs;
  if (paragraphs?.length) {
    return paragraphs.flatMap((p) =>
      (p.sentences || []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
    ).filter((s) => s.text);
  }
  const out = [];
  let cur = null;
  for (const w of alt.words || []) {
    const word = w.punctuated_word || w.word;
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push(word);
    cur.end = w.end;
    if (/[.!?]["”’)]*$/.test(word) || cur.words.length >= 60) {
      out.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
      cur = null;
    }
  }
  if (cur) out.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
  return out;
}

const wordCount = (s) => (s.match(/\S+/g) || []).length;

/**
 * Group sentences into passages of roughly `targetWords` words (~45–60s of
 * speech), always breaking on a sentence boundary, never exceeding `maxWords`
 * unless a single sentence is longer than that on its own. A short tail is
 * merged into the previous passage so nothing is a stub.
 */
export function chunkSentences(sentences, { targetWords = 130, maxWords = 220, minWords = 40 } = {}) {
  const chunks = [];
  let cur = [];
  let words = 0;
  const flush = () => {
    if (!cur.length) return;
    chunks.push({
      start_sec: round2(cur[0].start),
      end_sec: round2(cur[cur.length - 1].end),
      text: cur.map((s) => s.text).join(" "),
    });
    cur = [];
    words = 0;
  };
  for (const s of sentences) {
    const n = wordCount(s.text);
    if (cur.length && words + n > maxWords) flush();
    cur.push(s);
    words += n;
    if (words >= targetWords) flush();
  }
  if (cur.length) {
    const prev = chunks[chunks.length - 1];
    if (prev && words < minWords && wordCount(prev.text) + words <= maxWords + minWords) {
      prev.end_sec = round2(cur[cur.length - 1].end);
      prev.text += " " + cur.map((s) => s.text).join(" ");
      cur = [];
    } else {
      flush();
    }
  }
  return chunks.map((c, idx) => ({ idx, ...c }));
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Sentences → compact storage form [[start, end, text], ...] and back. */
export const packSentences = (ss) => ss.map((s) => [round2(s.start), round2(s.end), s.text]);
export const unpackSentences = (rows) => (rows || []).map(([start, end, text]) => ({ start, end, text }));

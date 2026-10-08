import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFeed, parseDuration, detectSpeaker, deepgramToSentences, chunkSentences,
  packSentences, unpackSentences, decodeXml, applePodcastId,
} from "../ingest/lib.mjs";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Skyline Church Podcast</title>
  <itunes:author>Skyline Church</itunes:author>
  <itunes:image href="https://cdn.example.com/show.jpg"/>
  <item>
    <title><![CDATA[9/24/2023 - Growth Path That Equips (Part 1)]]></title>
    <guid isPermaLink="false">ep-101</guid>
    <pubDate>Sun, 24 Sep 2023 14:00:00 GMT</pubDate>
    <itunes:author>Skyline Church</itunes:author>
    <description><![CDATA[<p>Pastor Chris Smith continues our series &amp; asks: what&#39;s next?</p>]]></description>
    <enclosure url="https://cdn.example.com/101.mp3?x=1&amp;y=2" length="1" type="audio/mpeg"/>
    <itunes:duration>41:05</itunes:duration>
    <link>https://example.com/ep/101</link>
  </item>
  <item>
    <title>Guest Sunday</title>
    <guid>ep-102</guid>
    <pubDate>Sun, 01 Oct 2023 14:00:00 GMT</pubDate>
    <itunes:author>Jane Doe</itunes:author>
    <itunes:image href="https://cdn.example.com/102.jpg"/>
    <enclosure url="https://cdn.example.com/102.mp3" type="audio/mpeg"/>
    <itunes:duration>2712</itunes:duration>
  </item>
  <item>
    <title>Announcement with no audio</title>
    <guid>ep-103</guid>
  </item>
</channel>
</rss>`;

test("parseFeed extracts audio episodes with clean metadata", () => {
  const eps = parseFeed(FEED);
  assert.equal(eps.length, 2, "items without an enclosure are skipped");
  const [a, b] = eps;
  assert.equal(a.guid, "ep-101");
  assert.equal(a.title, "9/24/2023 - Growth Path That Equips (Part 1)");
  assert.equal(a.description, "Pastor Chris Smith continues our series & asks: what's next?");
  assert.equal(a.audio_url, "https://cdn.example.com/101.mp3?x=1&y=2");
  assert.equal(a.published_at, "2023-09-24T14:00:00.000Z");
  assert.equal(a.duration_sec, 41 * 60 + 5);
  assert.equal(a.episode_url, "https://example.com/ep/101");
  assert.equal(a.image_url, "https://cdn.example.com/show.jpg", "falls back to the show artwork");
  assert.equal(a.speaker, "Pastor Chris Smith", "church-wide author ignored, name found in description");
  assert.equal(b.speaker, "Jane Doe", "item author that differs from the show author is used");
  assert.equal(b.image_url, "https://cdn.example.com/102.jpg");
  assert.equal(b.duration_sec, 2712);
});

test("parseFeed applies DEFAULT_SPEAKER and SERIES_PATTERN", () => {
  const eps = parseFeed(FEED.replace("Pastor Chris Smith", "We"), {
    defaultSpeaker: "Pastor Chris",
    seriesPattern: "- (.+?) \\(Part \\d+\\)",
  });
  assert.equal(eps[0].speaker, "Pastor Chris");
  assert.equal(eps[0].series, "Growth Path That Equips");
  assert.equal(eps[1].series, null);
});

test("parseDuration handles h:m:s, m:s, seconds, and junk", () => {
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("62:03"), 3723);
  assert.equal(parseDuration("3723"), 3723);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("abc"), null);
});

test("detectSpeaker prefers a distinct item author, then a titled name", () => {
  assert.equal(detectSpeaker({ itemAuthor: "Skyline", channelAuthor: "Skyline", title: "Hope | Rev. Ann Lee" }), "Rev. Ann Lee");
  assert.equal(detectSpeaker({ title: "Hope" }, "Fallback"), "Fallback");
  assert.equal(detectSpeaker({ title: "Hope" }), null);
});

test("decodeXml handles numeric and named entities", () => {
  assert.equal(decodeXml("Faith &amp; Works &#8212; &#x2019;"), "Faith & Works — ’");
});

const dgParagraphs = {
  metadata: { duration: 30 },
  results: { channels: [{ alternatives: [{
    paragraphs: { paragraphs: [
      { sentences: [{ start: 0.5, end: 3.2, text: "Good morning, church." }, { start: 3.4, end: 6, text: "Turn to Matthew 13." }] },
      { sentences: [{ start: 7, end: 12.25, text: "The kingdom is like a mustard seed." }] },
    ] },
    words: [],
  }] }] },
};

test("deepgramToSentences reads paragraphs/sentences", () => {
  const s = deepgramToSentences(dgParagraphs);
  assert.deepEqual(s.map((x) => x.text), ["Good morning, church.", "Turn to Matthew 13.", "The kingdom is like a mustard seed."]);
  assert.equal(s[2].start, 7);
  assert.equal(s[2].end, 12.25);
});

test("deepgramToSentences falls back to grouping words on punctuation", () => {
  const words = ["Hello", "church.", "Let's", "pray!", "Amen"].map((w, i) => ({ word: w.toLowerCase(), punctuated_word: w, start: i, end: i + 0.8 }));
  const s = deepgramToSentences({ results: { channels: [{ alternatives: [{ words }] }] } });
  assert.deepEqual(s.map((x) => x.text), ["Hello church.", "Let's pray!", "Amen"]);
  assert.deepEqual([s[1].start, s[1].end], [2, 3.8]);
  assert.deepEqual(deepgramToSentences({}), []);
});

function fakeSentences(n, wordsEach) {
  return Array.from({ length: n }, (_, i) => ({
    start: i * 5, end: i * 5 + 4.5, text: Array.from({ length: wordsEach }, (_, w) => `w${i}_${w}`).join(" ") + ".",
  }));
}

test("chunkSentences makes ~target-sized passages on sentence boundaries", () => {
  const sentences = fakeSentences(40, 20); // 800 words
  const chunks = chunkSentences(sentences, { targetWords: 130, maxWords: 220, minWords: 40 });
  assert.ok(chunks.length >= 5 && chunks.length <= 7, `got ${chunks.length}`);
  chunks.forEach((c, i) => {
    assert.equal(c.idx, i);
    const n = c.text.split(/\s+/).length;
    assert.ok(n <= 220 + 40, `chunk ${i} has ${n} words`);
    assert.ok(c.text.endsWith("."), "ends on a sentence boundary");
  });
  // Every sentence lands in exactly one chunk, in order, with matching times.
  assert.equal(chunks.map((c) => c.text).join(" "), sentences.map((s) => s.text).join(" "));
  assert.equal(chunks[0].start_sec, 0);
  assert.equal(chunks.at(-1).end_sec, sentences.at(-1).end);
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].start_sec >= chunks[i - 1].end_sec);
});

test("chunkSentences merges a short tail and keeps a giant sentence whole", () => {
  const s = [...fakeSentences(7, 20), { start: 100, end: 101, text: "Amen." }];
  const chunks = chunkSentences(s, { targetWords: 130, maxWords: 220, minWords: 40 });
  assert.equal(chunks.length, 1, "140 words + 1-word tail → one chunk");
  assert.ok(chunks[0].text.endsWith("Amen."));
  assert.equal(chunks[0].end_sec, 101);

  const giant = chunkSentences(fakeSentences(1, 300));
  assert.equal(giant.length, 1);
  assert.equal(chunkSentences([]).length, 0);
});

test("packSentences/unpackSentences round-trip", () => {
  const s = [{ start: 1.234, end: 2.5, text: "Hi." }];
  assert.deepEqual(unpackSentences(packSentences(s)), [{ start: 1.23, end: 2.5, text: "Hi." }]);
  assert.deepEqual(unpackSentences(null), []);
});

test("applePodcastId recognizes Apple Podcasts links and ids, not RSS feeds", () => {
  assert.equal(applePodcastId("https://podcasts.apple.com/us/podcast/skyline-church-podcast/id1480613754"), "1480613754");
  assert.equal(applePodcastId("https://podcasts.apple.com/us/podcast/skyline-church-podcast/id1480613754?i=1000700000000"), "1480613754");
  assert.equal(applePodcastId("1480613754"), "1480613754");
  assert.equal(applePodcastId("https://feeds.example.com/skyline/id1480613754.xml"), null);
  assert.equal(applePodcastId("https://anchor.fm/s/abc123/podcast/rss"), null);
  assert.equal(applePodcastId(""), null);
});

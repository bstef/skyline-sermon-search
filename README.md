# Skyline Sermon Search

Search every Skyline Church sermon by **word, phrase, or idea**, and jump straight to the moment it was said.

- **"mustard seed"** finds every time that exact phrase was said, with the audio cued to that second.
- **how do I deal with anxiety** finds passages about worry, fear and trusting God, even when the word "anxiety" never comes up.
- Sort by **newest/oldest** to answer "when did we last preach on this?"
- Filter by **speaker** and **year**; open the **full transcript** of any sermon; **copy a link** to an exact moment.
- Optional **AI summary**: one tap writes a short, cited summary of what the top passages say, where each [1] [2] plays that clip.

There's no build step. `public/index.html` is the whole front end, and a few Cloudflare Pages Functions make up the API.

## How it works

```
Podcast RSS ──► ingest job (GitHub Actions, weekly) ──► Supabase Postgres
                 │  Deepgram: audio → timestamped text            sermons
                 │  split into ~1-minute passages                 passages (text + full-text index
                 └─ Workers AI: passage → embedding                          + pgvector embedding)
                                                                     ▲
Browser ──► Cloudflare Pages ──► /api/search ─ embed the query ──────┘ hybrid search (one SQL call)
             public/index.html    /api/sermon   (Workers AI)
                                  /api/answer ─► Claude (optional)
```

**Search is hybrid.** `search_passages()` in `db/schema.sql` runs two searches in one query and merges them with Reciprocal Rank Fusion:

| | Keyword (Postgres full-text) | Meaning (pgvector embeddings) |
|---|---|---|
| Good at | exact words, `"quoted phrases"`, names, verses | ideas, paraphrases, questions |
| Example | `"seventy times seven"` | *why should I forgive someone who isn't sorry* |

Passages that rank well in both come first. **Exact words** mode turns off the meaning-based half, and sorting by date also uses keyword matches only. With a few hundred sermons a search is one embedding call plus one indexed query, typically well under half a second, and repeat searches are cached at Cloudflare's edge for 5 minutes.

## Repo layout

```
public/index.html          the search page (HTML/CSS/JS, no framework)
functions/api/search.js    GET  /api/search  hybrid search
functions/api/sermon.js    GET  /api/sermon  one sermon + full transcript
functions/api/stats.js     GET  /api/stats   archive size, speakers, years
functions/api/answer.js    POST /api/answer  optional AI summary (Claude), streamed
lib/server.js              helpers shared by the functions (not routed, not served)
db/schema.sql              tables, indexes, RLS, search function: run in Supabase
ingest/ingest.mjs          RSS → transcript → passages → embeddings → Supabase
ingest/lib.mjs             feed parsing + transcript chunking (pure, unit-tested)
.github/workflows/         weekly ingest + tests
test/                      unit tests, SQL tests (PGlite + pgvector), API tests
```

---

## Setup

You'll need free accounts at **Supabase**, **Cloudflare** and **Deepgram**. For the podcast itself, the Apple Podcasts link is enough: the ingest job asks Apple for the show's RSS feed each time it runs.

### 1. Database (Supabase)

1. [supabase.com](https://supabase.com) → **New project** (the free tier is enough).
2. **SQL Editor** → paste all of `db/schema.sql` → **Run**. (It's safe to re-run after future updates.)
3. **Project Settings → API**: note the **Project URL**, the **anon public** key, and the **service_role** key.
   The anon key is read-only under the Row Level Security policies in the schema. The service_role key can write, so only the ingest job gets it; never put it in the website.

### 2. Transcription (Deepgram)

[deepgram.com](https://deepgram.com) → sign up → **API Keys** → create a key. New accounts get free credit, which typically covers transcribing a full back catalog.

### 3. Embeddings (Cloudflare Workers AI)

The same embedding model, `@cf/baai/bge-base-en-v1.5`, turns passages (during ingest) and search queries (on the site) into vectors.

- **Account ID**: Cloudflare dashboard → any zone or Workers & Pages overview, right sidebar.
- **API token**: My Profile → **API Tokens** → Create Token → use the **Workers AI** template.

### 4. Ingest (GitHub Actions)

Repo → **Settings → Secrets and variables → Actions**.

**Secrets:**

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key from step 1 |
| `DEEPGRAM_API_KEY` | from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | from step 3 |
| `CLOUDFLARE_API_TOKEN` | from step 3 |

**Variables** (the Variables tab):

| Name | Value |
|---|---|
| `FEED_URL` | `https://podcasts.apple.com/us/podcast/skyline-church-podcast/id1480613754`, or the RSS feed URL directly if you have it |
| `DEFAULT_SPEAKER` | *(optional)* used when an episode doesn't name a speaker, e.g. `Pastor Chris` |
| `DEEPGRAM_KEYTERMS` | *(optional)* comma-separated names/words to transcribe correctly, e.g. `Skyline,Bloomfield,Pastor Chris` |
| `SERIES_PATTERN` | *(optional)* regex whose first group pulls a series name out of the title, e.g. `- (.+?) \(Part \d+\)` |

Then **Actions → Ingest sermons → Run workflow**:

1. First with args `--dry-run`. This lists every episode it found, with the detected speaker, and changes nothing. Check the speakers look right.
2. Then with limit `3` to test a few real ones end-to-end.
3. Then a large limit (e.g. `150`) to backfill the archive. Each run can go for up to ~5½ hours, so re-run until it reports *Nothing new to transcribe*.

After that it runs on its own every **Monday ~6am Eastern** and picks up Sunday's new episode. A failed episode is marked `error` (with the reason in `sermons.transcript_error`); retry it with `--retry-errors`.

To run it from your own machine instead: `export` the same names as environment variables and run `node ingest/ingest.mjs --limit 5` (Node 20+, no install needed).

### 5. Website (Cloudflare Pages)

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick this repo.
2. Build settings: Framework **None**, build command *(empty)*, output directory **`public`**. `wrangler.toml` also sets this, along with the Workers AI binding.
3. **Settings → Variables and Secrets** (Production *and* Preview):
   - `SUPABASE_URL`: Project URL
   - `SUPABASE_ANON_KEY`: the **anon** key (not service_role)
4. Deploy. You get a `*.pages.dev` URL, and every push to `main` redeploys.

### 6. Your own address, and the church website

- **Custom domain:** Pages project → **Custom domains** → e.g. `sermons.skylinechurchnj.org`. If the domain's DNS isn't on Cloudflare, Cloudflare will tell you which CNAME record to add at your DNS provider.
- **Link it** from the church site's nav ("Search sermons"), or **embed it** in any page builder that allows an embed/HTML block (Squarespace, Wix, WordPress, etc.). `?embed=1` hides the page's own header:

  ```html
  <iframe src="https://sermons.skylinechurchnj.org/?embed=1"
          style="width:100%;height:900px;border:0" title="Sermon search"></iframe>
  ```

### 7. Optional: AI summaries (Claude)

Add `ANTHROPIC_API_KEY` (a [Claude Console](https://console.anthropic.com) API key) as a Pages **secret** and redeploy. A **✨ Summarize what was said** button then appears above results. It only runs when someone taps it, never on every search.

- It reads only the top 8 passages on screen (re-read from the database, not trusted from the browser) and must cite them; it's told not to add outside theology.
- Default model is `claude-opus-5-5` at low effort. That's roughly one to two cents per summary at current prices. To make it much cheaper, set a Pages variable `ANSWER_MODEL=claude-haiku-5-5`.
- If a request is ever declined by a safety filter, the API retries it on a recommended fallback model automatically (`fallbacks: "default"`).
- Because the site has no login, add a [Cloudflare Rate Limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) (free plan) on `/api/answer`, for example 10 requests per IP per 10 minutes, so nobody can run up the bill. Requests from other websites are already refused.

## Running costs (approximate)

| | Cost |
|---|---|
| Cloudflare Pages + Workers AI embeddings | free tier |
| Supabase | free tier (a few hundred sermons is well under 100 MB) |
| GitHub Actions | free |
| Deepgram | about half a cent per audio minute, so roughly $0.20 per sermon. New accounts get free credit that usually covers the back catalog |
| Claude summaries | optional; see above |

One caveat: Supabase pauses free projects after a long stretch with no activity. Weekly ingest plus normal site traffic keep it awake, and if it does pause, one click in the dashboard restores it.

## Fixing data by hand

Everything is editable in Supabase's **Table Editor**:

- **Speaker or series wrong?** Edit `sermons.speaker` / `sermons.series`. The weekly sync only inserts new episodes, so your edits stick.
- **Hide an episode** (a guest announcement, a duplicate): set `transcript_status` to `skipped` and delete its rows from `passages`.
- **Re-transcribe one episode:** run the workflow with args `--guid <the episode's guid>`.
- **Changed how passages are split?** `--rechunk` rebuilds passages and embeddings from the stored transcripts, with no new Deepgram cost.
- **Search tuning:** `SEMANTIC_MIN_SIMILARITY` (Pages variable, default `0.5`) is how close in meaning a passage must be before it's shown as a "related" match. Raise it if loosely related results show up; lower it if good ones are missing.

## Development

```bash
npm install
npm test                 # unit + SQL (in-process Postgres with pgvector) + API tests
npx wrangler pages dev   # site + functions at http://localhost:8788 (needs a .dev.vars, see below)
```

`.dev.vars` (git-ignored):

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
ANTHROPIC_API_KEY=...    # optional
```

Locally, the Workers AI binding needs `wrangler login` (it runs on Cloudflare). Without it, search falls back to keyword-only, so everything else still works.

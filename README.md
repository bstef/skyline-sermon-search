# Skyline Sermon Search

A first working foundation for searching Skyline Church in Bloomfield, New Jersey. Search saved sermon passages, read their context, and start the original podcast audio at the passage timestamp.

## Run locally

Python 3.11+ is required. No AI key is needed to browse the podcast or search imported transcripts with keywords.

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m sermon_search.cli sync
uvicorn sermon_search.app:app --host 127.0.0.1 --port 8000
```

Open http://localhost:8000. The current feed has 481 episodes as of October 8, 2026. Sync imports episode metadata, not transcripts. Until transcripts are imported, search correctly returns no passages. Library cards show which sermons have been transcribed. All archive audio can be played before transcription.

## Add transcripts without choosing an AI provider

```sh
python -m sermon_search.cli list
python -m sermon_search.cli import EPISODE_ID path/to/transcript.json
```

Use the ID printed by `list`. The JSON format is:

```json
{"segments":[
  {"start":125.2,"end":143.8,"text":"Actual transcribed words from this sermon."},
  {"start":143.8,"end":162.0,"text":"The following passage."}
]}
```

Times are seconds from the start of the original podcast. Import validates time ranges, preserves source wording, and builds overlapping passages of about 60 seconds (up to 220 words). A single unusually long source segment remains intact. Reimporting replaces that episode's passages and invalidates its embeddings atomically. Automated transcripts and their timing should be checked against audio before relying on quotations.

## Optional OpenAI processing

These commands make paid API calls. No paid processing has been run in this initial build. Keep the API key in the backend environment. `.env.example` documents variables; the app does not auto-load `.env` files.

```sh
export OPENAI_API_KEY='your-key'
# Install ffmpeg through your system package manager; ffprobe is included.
python -m sermon_search.cli transcribe EPISODE_ID
python -m sermon_search.cli embed
```

`transcribe` downloads one sermon, splits it into compressed 10-minute audio files, and requests segment timestamps using `whisper-1`. Completed chunk responses are cached under `data/transcripts/` so reruns can resume. Both ffmpeg and ffprobe must be available. Timestamps are approximate; splitting and compressed audio can introduce small boundary drift. An imported transcript from another provider works equally well.

`embed` indexes only missing passage embeddings with `text-embedding-3-small`, using 512 dimensions. The web server uses one query embedding per distinct smart query, cached in memory (256 entries per worker). It merges keyword and cosine rankings with reciprocal rank fusion, filters low semantic similarity, and removes overlapping duplicate hits. If AI is unavailable, it returns keyword results with a visible notice. API queries have bounded lengths; provider timeouts and retries are bounded.

References: [timestamped transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [embeddings](https://developers.openai.com/api/docs/guides/embeddings).

## Design

- FastAPI serves a responsive web interface and read-only APIs.
- The header uses the blue–green color logos with black/white lettering from [skylinebrand](https://github.com/bstef/skylinebrand), bundled locally under `sermon_search/static/`. Instrument Sans and Instrument Serif are self-hosted from the same repository, with their OFL licenses included. Both themes use blue, teal, and green tones derived from the logo (blue `#27aae1`, green `#39b54a`), with darker or lighter variants for readable text.
- A sun/moon toggle switches light and dark themes. The initial theme follows the device preference; a user choice is saved locally and applied before the page paints.
- SQLite FTS5 indexes transcript passages for fast keyword retrieval.
- NumPy searches normalized precomputed embeddings; the matrix is cached until the index changes. This is appropriate to validate an archive of this size, but latency and memory must be measured with the full transcript corpus. Move vectors to an indexed vector database if the archive or concurrency outgrows this approach.
- RSS GUIDs create stable episode IDs, preventing duplicate imports. Rerunning `sync` preserves transcripts.
- Metadata and transcripts are separate: descriptions are never passed off as sermon quotations.
- A single HTML audio player seeks in the original podcast file. Playback and seeking depend on the podcast host's browser/range support.
- Search links retain query and mode in the URL.

## Hosting and church website integration

The app can run on a separate site or a church subdomain. Deploy the Python service behind HTTPS with persistent storage for `data/sermons.sqlite3`; ephemeral hosting will lose the index. A container definition is included. Configure `SERMON_DB=/data/sermons.sqlite3` with a persistent `/data` volume.

Start with a separate site linked from the church's Watch page. An iframe is another option if the church's Nucleus page editor permits it; that integration has not been checked. A same-domain `/sermon-search` URL needs reverse-proxy support and base-path handling, which this foundation does not include.

Before public use, add gateway rate limits and a concurrency/spend cap for the paid smart-search endpoint, restrict cross-site framing to approved church domains, and establish backups and a scheduled ingestion job. The foundation has no admin web endpoints: paid processing and metadata updates use local CLI commands. Pilot 5–10 real sermons before indexing the entire archive; evaluate wording, natural-language relevance, and playback timestamps on actual audio. Speaker/series filters, scheduled imports, and an admin dashboard remain future work.

## Verify

```sh
python -m unittest discover -s tests -v
```

The tests cover idempotent feed sync, accurate timestamp retrieval, transcript replacement, invalid input, chunk overlap, semantic-only matches, and provider failure fallback. Semantic tests use mock vectors; they do not establish real model relevance or provider availability.

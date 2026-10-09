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

## Groq transcription (manual start only)

Transcription uses **Groq Whisper Large V3** by default. No transcription starts at web-server startup, during `sync`, or when a key is configured. No schedule is installed. The explicit `transcribe` command makes paid API calls; `--dry-run` does not download audio or call any API.

Keep credentials in the backend environment. `.env.example` documents variables; the app does not auto-load `.env` files. Obtain a key from [Groq Console](https://console.groq.com/keys).

```sh
export GROQ_API_KEY='your-groq-key'
# Optional cheaper model; default is whisper-large-v3.
# export GROQ_TRANSCRIPTION_MODEL='whisper-large-v3-turbo'
python -m sermon_search.cli list
# Safe configuration check. Replace EPISODE_ID with an ID from list.
python -m sermon_search.cli transcribe EPISODE_ID --dry-run
```

When ready to start processing one sermon explicitly:

```sh
# Install ffmpeg through your system package manager; ffprobe is included.
python -m sermon_search.cli transcribe EPISODE_ID
```

`transcribe` downloads one sermon and splits it into lossless 16 kHz mono, 10-minute FLAC chunks below Groq's 25 MB free-tier upload limit. Groq returns timestamped segments that are imported into the existing passage index. Transcription requests use a 120-second timeout with up to two SDK retries; rate limits can still stop a run. Running the same command again resumes completed chunk responses.

Checkpoints are separated by provider, model, and processing settings to avoid mixing Groq with earlier OpenAI output. They are saved under `transcripts/` next to the database (override with `TRANSCRIPT_CACHE_DIR`). Completed responses are written atomically. A failed or invalid transcript import preserves any previously indexed passages. Rerunning a successfully completed episode reimports its transcript and clears its embeddings, so run `embed` afterward. Concurrent processing of the same episode is not supported yet. Bulk jobs and weekly scheduling remain future work.

Timestamp offsets use actual chunk durations. FLAC avoids MP3 padding accumulation, but model timestamps are still approximate and should be checked against the original audio. No live Groq transcription has been tested in this build; integration tests use mock responses and make no paid calls.

References: [Groq speech-to-text and timestamps](https://console.groq.com/docs/speech-to-text), [SDK compatibility endpoint](https://console.groq.com/docs/openai).

## Optional embeddings for contextual search

Groq transcription and search embeddings use separate credentials. Groq alone enables keyword search of the transcribed passages. Meaning-based search uses the existing OpenAI embeddings integration:

```sh
export OPENAI_API_KEY='your-openai-key'
python -m sermon_search.cli embed
```

`embed` makes paid API calls and indexes only missing passage embeddings with `text-embedding-3-small`, using 512 dimensions. The web server uses one query embedding per distinct smart query, cached in memory (256 entries per worker). It merges keyword and cosine rankings with reciprocal rank fusion, filters low semantic similarity, and removes overlapping duplicate hits. If AI is unavailable, it returns keyword results with a visible notice. API queries have bounded lengths; provider timeouts and retries are bounded.

Reference: [OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings).

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
- `/calendar` shows month, week, and agenda views with date navigation, a date picker, sermon details, and playback. Calendar dates come from the sermon title when it starts with a valid M/D/YYYY date, falling back to podcast publication. The chosen view is saved locally, and date/view links can be shared.

## Hosting and church website integration

The app can run on a separate site or a church subdomain. Deploy the Python service behind HTTPS with persistent storage for `data/sermons.sqlite3`; ephemeral hosting will lose the index. A container definition is included. Configure `SERMON_DB=/data/sermons.sqlite3` with a persistent `/data` volume.

Start with a separate site linked from the church's Watch page. An iframe is another option if the church's Nucleus page editor permits it; that integration has not been checked. A same-domain `/sermon-search` URL needs reverse-proxy support and base-path handling, which this foundation does not include.

Before public use, add gateway rate limits and a concurrency/spend cap for the paid smart-search endpoint, restrict cross-site framing to approved church domains, and establish backups and a scheduled ingestion job. The foundation has no admin web endpoints: paid processing and metadata updates use local CLI commands. Pilot 5–10 real sermons before indexing the entire archive; evaluate wording, natural-language relevance, and playback timestamps on actual audio. Speaker/series filters, scheduled imports, and an admin dashboard remain future work.

## Verify

```sh
python -m unittest discover -s tests -v
```

The tests cover idempotent feed sync, accurate timestamp retrieval, transcript replacement, invalid input, chunk overlap, semantic-only matches, and provider failure fallback. Semantic tests use mock vectors; they do not establish real model relevance or provider availability.

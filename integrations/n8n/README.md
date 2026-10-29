> For the active six-runs-per-day archive workflow, see [Automatic processing](AUTOMATION.md). The older weekly template below remains a safe inactive preview.

# Skyline Echo: n8n + Groq on a Proxmox LXC

n8n imports **workflows**, so this package provides an importable JSON workflow and a small Python runner. It is for n8n installed directly in a Debian/Ubuntu LXC. No GPU is needed: FFmpeg processes audio locally, then Groq receives the audio chunks for transcription.

## What it does

Manual trigger or weekly check → sync Skyline's podcast RSS → select pending sermons → split audio into 10-minute, mono 16 kHz FLAC chunks → Groq timestamped transcription → save JSON and index passages in local SQLite → return a run report to n8n.

- Imported workflow is inactive; schedule node is disabled; configuration defaults to `dry_run: true`.
- Preview fetches RSS metadata, creates local bookkeeping and reports candidates. It never downloads sermon audio or calls Groq.
- Default model is `whisper-large-v3-turbo`. Switch to `whisper-large-v3` for Groq's higher-accuracy option. Biblical names still benefit from review.
- One sermon per run by default, oldest pending first. Already indexed sermons are skipped.
- First run records a cutoff 14 days earlier. That fixed cutoff permits catch-up after downtime without automatically processing the entire archive. Feed publication dates determine eligibility.
- Completed audio chunks are checkpointed. A later run resumes them after a transient failure. The existing Groq SDK retries transient API failures twice; persistent failures make the n8n execution fail.
- A filesystem lock prevents overlapping runs. Retain and back up the data directory to preserve both transcripts and completion state.
- No embedding requests. Optional protected Cloudflare publication is disabled by default; see [PUBLISHING.md](PUBLISHING.md).

## 1. Install the companion package in the LXC

Download the supplied `skyline-echo-n8n.zip` to the LXC. The archive contains a `skyline-echo/` directory with the Python modules, requirements and workflow. It does not include secrets or audio. Run:

```sh
sudo apt-get update
sudo apt-get install -y python3 python3-venv ffmpeg unzip
sudo unzip skylitaphne-echo-n8n.zip -d /opt
sudo python3 -m venv /opt/skyline-echo/.venv
sudo /opt/skyline-echo/.venv/bin/pip install -r /opt/skyline-echo/requirements.txt
sudo cp /opt/skyline-echo/integrations/n8n/config.example.json /opt/skyline-echo/integrations/n8n/config.json
```

Use the actual account running your n8n service. For systemd, inspect `systemctl show n8n --property=User`; your service name may differ. An empty User value means systemd's default root account. The example below assumes an existing `n8n` account:

```sh
sudo install -d -o n8n -g n8n -m 750 /var/lib/skyline-echo
```

The n8n account needs read/execute access to `/opt/skyline-echo` and write access to `/var/lib/skyline-echo`. Run this on each execution worker too if using n8n queue mode.

## 2. Allow the Execute Command node

n8n 2 disables this node by default. On a systemd installation, use `sudo systemctl edit n8n` and add:

```ini
[Service]
Environment='NODES_EXCLUDE=["n8n-nodes-base.localFileTrigger"]'
EnvironmentFile=-/etc/skyline-echo.env
```

This enables Execute Command while leaving Local File Trigger excluded. If you already exclude additional nodes, preserve those entries and remove only `n8n-nodes-base.executeCommand`. For another service manager, set the equivalent environment variables in its configuration. Restart your n8n service after the change.

The workflow executes a fixed command; RSS titles and descriptions are never inserted into shell commands. Give workflow-editing access only to trusted administrators, since Execute Command permits shell access.

## 3. Import and preview first

In n8n's workflow menu choose **Import from File**, then select `skyline-echo-groq.workflow.json`. Leave the workflow unpublished/inactive and the weekly trigger disabled.

Click **Execute Workflow**. The `Run report` node should show `status: preview`, `dry_run: true`, selected episode details and whether FFmpeg is available. A Groq key is not needed for preview.

The companion runner must be installed; importing the JSON alone cannot install Python or FFmpeg. If you use a different installation directory, update the fixed command in `Sync RSS and process bounded batch`.

## 4. Add Groq credentials when ready

Create a Groq API key in your own account. Keep it out of the workflow JSON, Git and command-line arguments. For the systemd setup above:

```sh
sudo install -m 600 /dev/null /etc/skyline-echo.env
sudoedit /etc/skyline-echo.env
```

Add `GROQ_API_KEY=YOUR_KEY_HERE`, save and restart n8n. The runner inherits the service environment. The placeholder is not a working key. Use your service manager's environment/secret facility if not using systemd.

## 5. Start only when you choose

Edit `/opt/skyline-echo/integrations/n8n/config.json` and set `dry_run` to `false`. A subsequent manual execution downloads and transcribes up to `max_episodes` sermons; Groq account charges or free-tier limits apply.

After checking one result, enable the weekly trigger and publish/activate the workflow. Its timezone is `America/New_York` and it checks at 06:00 every Monday, allowing Sunday podcast uploads time to arrive. Most checks will find nothing to transcribe. No schedule has been enabled by creating this package.

For archive backfill, deliberately set `include_archive: true`. Keep the batch small and run repeatedly; this can process the full archive over time. Set it back to `false` for ongoing use. You can instead specify an ISO `since` date such as `2026-10-01`. Changing the model does not automatically reprocess completed sermons.

## Outputs and Skyline Echo integration

Data is under `/var/lib/skyline-echo`:

- `sermons.sqlite3`: podcast metadata, completed transcripts and searchable passages.
- `transcripts/<episode-id>/groq/<model>/flac-16k-segments-v1/transcript.json`: complete transcript with `episode_id` and `segments` containing `start`, `end` (seconds from the original audio) and `text`.
- Chunk JSON files beside the transcript: resumable Groq response checkpoints.
- `first-run.json`: persisted initial cutoff.
- `last-run.json`: latest preview/success/failure report. Failed episodes remain eligible for retry.

The temporary original audio and FLAC chunks are removed after each attempt. Make sure the LXC has enough temporary disk space for an entire sermon and its converted audio.

The transcripts use the same episode IDs and format as Skyline Echo. To bring one into your **canonical app database**, first sync podcast metadata there, then import the copied transcript:

```sh
python -m sermon_search.cli sync
python -m sermon_search.cli import EPISODE_ID /path/to/transcript.json
```

Those commands use the app's `SERMON_DB` environment setting (or its default `data/sermons.sqlite3`). They make no AI calls. The app's existing `export-cloudflare` command can then prepare the canonical database for D1 publication. Do not combine full SQL exports from independently populated databases: local passage IDs can collide. Import transcript JSON into a single canonical database first.

Optional automatic publication is now available through a protected Worker endpoint. Follow [PUBLISHING.md](PUBLISHING.md) to install the separate private token and test the connection with a synthetic sample. Publication remains disabled by default. Keyword search works once real passages are published; semantic embeddings are a separate optional stage.

## Troubleshooting and verification

- Unknown/disabled node: check `NODES_EXCLUDE` and restart n8n.
- Permission error: confirm the n8n service user and data directory ownership.
- Missing FFmpeg: install `ffmpeg` in the LXC itself and ensure it is on the service's PATH.
- Failed execution: review `last-run.json`, Groq usage/rate limits, key permissions and network connectivity. Errors omit provider bodies to avoid putting request details into n8n logs.
- To force preview from the LXC even if the configuration enables processing:

```sh
cd /opt/skyline-echo
.venv/bin/python -m sermon_search.n8n --config integrations/n8n/config.json --dry-run
```

Runner, publication and existing Groq transcription tests passed using mocked data/API transport. No real sermon transcription was started. Import and live execution still need verification on your n8n instance.

References: [n8n workflow import](https://docs.n8n.io/build/manage-workflows/export-and-import.md), [Execute Command](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/), [Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/), [Groq speech-to-text](https://console.groq.com/docs/speech-to-text).

## Daily report workflow recovery

A [sanitized one-time backup and restore guide](backup/README.md) for the daily transcription and cost email workflow is available in [`backup/`](backup/). The template imports inactive and requires your sender/recipient addresses, application URLs and a Resend credential. Keep the exact deployment export, server databases and secrets in separate private storage. No recurring backup job is installed.

# Automatic archive processing without a desktop computer

The production n8n workflow runs on the Proxmox LXC. Your computer, browser, and this chat can be closed. The Proxmox host, LXC, n8n service, and internet connection must remain available.

## Production schedule

The workflow **Skyline Echo — Automatic archive + weekly sermons (6/day)** uses `0 0,4,8,12,16,20 * * *` with the explicit timezone `America/New_York`: midnight, 4 a.m., 8 a.m., noon, 4 p.m., and 8 p.m., following the church's daylight-saving time. It attempts at most one sermon per run. New messages published in the last 14 days are processed ahead of older archive episodes. Future-dated publications and episodes already indexed locally are skipped.

Publishing the workflow in n8n activates its server-side schedule. Saving a draft or leaving its editor open does not activate it. Imported copies remain inactive; do not publish a second copy alongside the production workflow.

## Audio allowance

`sermon_search/budget.py` stores request reservations in `/var/lib/skyline-echo/groq-audio-budget.sqlite3`. The automatic runner limits usage to:

- **5,400 audio seconds per rolling hour** (90 minutes).
- **21,600 audio seconds per rolling 24 hours** (six hours).
- **Six distinct sermons per rolling 24 hours**, including partial attempts. A previously started sermon can resume within its audio allowance.

These are below the verified Groq organization limits of 7,200 seconds/hour and 28,800 seconds/day. The known pre-ledger trial is conservatively seeded as 2,400 seconds when installing the first production budget within 24 hours of that trial.

Reservations are rounded up and committed before an API call. Failed or uncertain attempts still count. A crash or LXC restart does not reset the allowance. SQLite transactions make the check and reservation atomic, while the runner's process lock prevents overlapping jobs. Automatic SDK retries are disabled in budget mode, so requests cannot silently bypass the ledger. A Groq 429 starts a persistent 24-hour cooldown; scheduled runs defer rather than repeatedly requesting more audio.

This controls this runner's requests. Other applications using the same Groq organization share provider limits; the runner handles provider throttling but cannot observe their exact usage. No paid-plan upgrade or provider fallback is performed. Keep the Groq account on its free tier if zero provider charges are required.

Saved responses are reused without a new reservation. Original provider responses are checkpointed before timestamp validation so a failed validation does not repeat a successful provider call. Long sermons may span runs if a budget is reached. Publication of saved transcripts is retried separately, including when transcription is deferred.

## Configuration

The production runner reads `/opt/skyline-echo/integrations/n8n/config.automated.json`, separate from the original preview config. Use `config.automated.example.json` as a template. The checked-in example defaults to `dry_run: true`; the explicitly enabled production file uses `dry_run: false`. Credentials remain in the existing n8n service environment and private publishing-token file, outside Git and workflow JSON.

The normal command is:

```sh
cd /opt/skyline-echo
```

```sh
.venv/bin/python -m sermon_search.n8n --config integrations/n8n/config.automated.json
```

Preview without downloading or transcribing audio:

```sh
.venv/bin/python -m sermon_search.n8n --config integrations/n8n/config.automated.json --dry-run
```

## Check progress or pause

Open the workflow's **Executions** tab and inspect **Archive progress**. Successful reports include `completed`, `publishing`, and `audio_budget`; a budget wait reports `status: deferred`, its reason, and `retry_after_epoch`. `/var/lib/skyline-echo/last-run.json` retains the latest report. Provider failures are reported with a generic exception type rather than credential-bearing response bodies.

To stop future scheduled processing, unpublish/deactivate the production workflow in n8n. Setting the production config's `dry_run` to `true` makes scheduled runs preview-only. Restarting n8n does not erase the ledger or completed transcripts. The original weekly preview workflow and the manual trial workflow are not scheduled.

At the measured archive average of 34.8 minutes, six sermons use about 3.5 audio hours/day. Roughly 80 days is a planning estimate for the current backlog, with variation for duration, new episodes, downtime, and deferrals. This is an up-to-six schedule, not a guarantee that six complete each day.

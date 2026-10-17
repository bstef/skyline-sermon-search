# Connect Skyline Echo publishing

The protected endpoint is `https://skylinechurch.app/api/admin/transcripts`. It accepts a Bearer credential scoped to publishing sermon metadata and transcript passages. The LXC does not need a Cloudflare account token. Groq is not involved in publication or the sample test.

## Install the update and private credential

Copy the updated `skyline-echo-n8n.zip` and the separate `skyline-echo-publish.token` from your Mac's Downloads directory to the LXC. **The ZIP does not contain the credential.** Keep the token private; do not add it to Git or workflow JSON. Use the same SCP / Proxmox `pct push` transfer method used for the first ZIP. Your n8n container ID is 112.

After the files are in `/tmp` in the LXC, run each line separately:

```sh
unzip -o /tmp/skyline-echo-n8n.zip -d /opt
install -o root -g root -m 600 /tmp/skyline-echo-publish.token /etc/skyline-echo-publish.token
```

This updates the Python modules and adds the sample files. It preserves the existing `config.json` and `/var/lib/skyline-echo` data. The token file is read directly by the publisher, so n8n does not need a service restart. Your current n8n runs as root. If you later change that account, adjust ownership while retaining permissions 600.

## Test the connection without transcribing or publishing sample text

Import `skyline-echo-publishing-test.workflow.json` as a **separate new workflow**, then verify the connections: Test manually → Validate sample with Cloudflare → Publishing test result. It has no schedule, is inactive, and never invokes Groq.

Click Execute workflow. Open Publishing test result and its JSON output. Expected:

```json
{"status":"validated","dry_run":true,"episode_id":"00000000000000000000","passages":1}
```

The full response also includes the test title and a content hash. This validates authentication, the payload and timestamp grouping. It deliberately makes no database writes. The endpoint rejects `sample: true` with `dry_run: false`, protecting against accidental publication of the fixture.

You can perform the identical test directly inside the LXC:

```sh
cd /opt/skyline-echo
.venv/bin/python -m sermon_search.publishing --endpoint https://skylinechurch.app/api/admin/transcripts --file integrations/n8n/sample-publication.json
```

The publisher identifies itself as SkylineEchoPublisher/1.0, requires HTTPS and refuses redirects so the token cannot be forwarded to another host. It never prints the token or provider response bodies on errors.

## Enable publication of real transcripts later

When ready, add this object to the existing `/opt/skyline-echo/integrations/n8n/config.json` (preserve your other fields):

```json
"publishing": {
  "enabled": true,
  "dry_run": false,
  "endpoint": "https://skylinechurch.app/api/admin/transcripts"
}
```

The main runner then publishes saved real transcripts after processing. Global `dry_run: true` still prevents both Groq processing and this automatic publishing stage. Neither setting is changed by installing the package or running the separate sample test.

Successful publication updates D1 and keyword search immediately, without rebuilding the website. New episode metadata is included, so new weekly sermons can appear even if the website's older metadata migration did not include them. Passage IDs are assigned by D1 rather than copied from the LXC.

The LXC keeps a separate `transcripts/<episode-id>/publication.json` receipt. If publication fails after transcription, the original transcript remains saved and the next enabled run retries its upload without calling Groq for that completed sermon again. Identical content gets an `already_published` response; changed transcripts replace the previous passages in one database transaction. The first version does not create semantic embeddings.

## What was verified

- Local Worker tests: authorized writes, keyword search timestamps, replacement, identical/concurrent retries, invalid inputs, and rollback preserving the old transcript after a failed insertion.
- Python tests: separate publication receipts, retrying failed publication, validation not marking publication complete, using original transcripts after changing the transcription model, destination changes, HTTPS/redirect checks and missing credentials.
- Live Cloudflare sample: authenticated validation returned `validated`, invalid credentials returned 401, sample writes and invalid timestamps returned 422. Public stats remained 481 episodes and zero indexed transcripts. No Groq API was called.

The LXC-to-Cloudflare sample test passed after installing the updated modules and token. On October 17, 2026, a real Groq Turbo trial transcribed the September 27 sermon in 42.48 seconds, returned 277 segments, and published 46 passages. Live keyword search and browser audio seeking worked. Human spot-checking of wording and timestamp accuracy remains necessary. The weekly workflow remains inactive and its main runner config remains in dry-run.

The trial exposed missing FLAC duration metadata. The corrected runner counts decoded 16 kHz audio samples for each chunk rather than trusting container duration; install the latest `sermon_search/transcription.py` when updating an older LXC runner.

## Rotation

Replace the Worker secret `TRANSCRIPT_PUBLISH_TOKEN` and the LXC token file with the same new random value when rotating the publishing credential. Do not rotate the Groq key as part of this operation. Publishing is disabled if the Worker secret is absent.

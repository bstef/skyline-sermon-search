# One-time daily report workflow backup

Public, sanitized snapshot created October 29, 2026. This folder preserves the Skyline Echo daily transcription and cost report workflow for rebuilding a self-hosted n8n server. It does not install a backup schedule or change the running workflow.

## Contents and scope

- [`daily-report.workflow.json`](daily-report.workflow.json): importable workflow with all nine nodes and their connections. It is inactive, explicitly uses `America/New_York`, has no saved credentials or execution data, and uses example sender/recipient addresses and application/n8n URLs.
- [`build-daily-ledger-report.py`](build-daily-ledger-report.py): readable version of the Python embedded in the report node. It generates a report and caches its payload; Resend sending happens in the separate HTTP Request node.
- [`SHA256SUMS.txt`](SHA256SUMS.txt): file integrity checksums. Run `shasum -a 256 -c SHA256SUMS.txt` from this folder after downloading it.

This is a recovery template for the daily email workflow only. The other transcription workflows remain in the parent directory. It contains no API keys, real recipient addresses, instance workflow/credential IDs, server databases, sent markers or full n8n instance backup. Keep the exact deployment export and secrets in private storage. Importing this public template requires configuration before it can send a useful report.

## Rebuild prerequisites

Follow the [n8n installation guide](../README.md) and [publishing guide](../PUBLISHING.md) for the application's companion package. Recreate the original n8n version/deployment where possible. This snapshot does not establish the installed version or provide a server image.

The report runs `/opt/skyline-echo/.venv/bin/python`. Recreate that virtual environment on the new machine with Python 3.11+ and timezone data for `America/New_York`. The report itself uses the standard library. Both Execute Command nodes must be available: on n8n 2+, they are disabled by default. Use the parent installation guide to restore the needed capability while preserving other node restrictions.

Commands run in n8n's execution environment. For Docker, install/mount the Python runtime and data inside the container; for queue mode, also configure the execution workers. The n8n service account needs read access to the ledgers and write access to the email-reports directory.

Restore these separately from a consistent private server backup:

| Path | Purpose |
| --- | --- |
| `/var/lib/skyline-echo/groq-audio-budget.sqlite3` | Audio ledger (`audio_requests`, `cooldown` tables) |
| `/var/lib/skyline-echo/sermons.sqlite3` | Sermon/transcript database (`episodes`, `passages` tables) |
| `/var/lib/skyline-echo/run-history.jsonl` | Run counts and outcomes, when present |
| `/var/lib/skyline-echo/groq-dashboard-status.json` | Saved billing observation, when present |
| `/var/lib/skyline-echo/email-reports/` | Cached payloads and accepted-send markers |

Stop data writers or use a consistent SQLite backup/snapshot method when capturing databases. Copying a changing SQLite database as an ordinary file can produce an inconsistent backup. The report's historical billing defaults and verification date reflect the original snapshot; they do not verify current billing. Restore/update the saved observation appropriately before relying on it.

## Restore the workflow

1. Download this folder from GitHub. In n8n, create a workflow and select **Import → From file** / **Import from File**, then choose `daily-report.workflow.json`. Leave it unpublished/inactive.
2. Edit `build-daily-ledger-report.py` locally. Replace `reports@example.com`, `recipient-one@example.com` and `recipient-two@example.com` with the intended sender and recipients. Replace `https://app.example.com` with your application URL (the report fetches `/api/stats`), and replace `https://n8n.example.com/workflow/REPLACE_WORKFLOW_ID/executions` with your transcription workflow's executions URL. Keep your configured copy private.
3. Re-encode the configured Python and paste the resulting command into **Build daily ledger report → Parameters → Command**, keeping Expression mode. From this folder, run:

   ```sh
   python3 - <<'PYCODE'
   import ast, base64
   from pathlib import Path
   source = Path('build-daily-ledger-report.py').read_text()
   ast.parse(source)
   payload = base64.b64encode(source.encode()).decode()
   print('SKYLINE_REPORT_TEST={{ $json.report_test ? \'1\' : \'0\' }} '
         '/opt/skyline-echo/.venv/bin/python -c '
         + "'import base64;exec(base64.b64decode(\"" + payload + "\"))'")
   PYCODE
   ```

   Editing the standalone Python file does not automatically change the JSON workflow. If you change the deployment paths, also update the report command and **Record successful send** command.
4. In **Send through Resend**, select/create a **Header Auth** credential. Use header name `Authorization` and value `Bearer YOUR_RESEND_API_KEY`, retrieved from secure storage. The workflow intentionally has no credential selected. Verify the sending domain in Resend and permit outbound requests to your application and `https://api.resend.com/emails`.
5. Confirm the workflow timezone is `America/New_York`. The schedule is `50 23 * * *`, meaning 11:50 p.m. Eastern.
6. Validate report generation first. Executing the builder creates a cached report but does not itself send mail. Executing the full manual branch sends the report to the configured recipients.
7. When ready to send a test, select **Send setup test manually** and execute once. Confirm Resend returns an email ID, validation succeeds, the successful-send marker is recorded, and recipients actually receive the email. API acceptance alone does not establish inbox delivery.
8. Publish/activate after verification. Avoid having the old and rebuilt server run the same daily schedule simultaneously.

## One-time test and duplicate protection

This snapshot uses `setup-resend-recipients-v3` as a fixed setup-test identifier. If its `.sent.json` marker already exists, the run returns `skip: true` with reason `already_accepted_by_resend` and stops before Resend. A cached payload can also retain earlier recipient settings.

For a deliberate fresh manual test, use a new test identifier in the readable Python and re-encode it before running. Daily reports use the Eastern calendar date, with persistent markers and a Resend idempotency key. Preserve those protections and markers through recovery. Do not remove production sent markers to force a test.

## Refresh this backup when you choose

After meaningful workflow changes, export JSON from n8n's three-dot workflow menu. Review decoded scripts as well as the outer JSON before committing a sanitized inactive copy here. Remove recipients, credential references, instance URLs/IDs, pinned data, logs and secrets. Update the readable Python copy and regenerate `SHA256SUMS.txt`. No daily backup automation is required.

Keep private server data, API keys, credential exports, n8n's encryption key and deployment configuration outside this public repository. For full instance recovery, separately preserve the n8n database and encryption key; this template instead lets you recreate the Resend credential.

## Verification

The workflow JSON, node connections and Python syntax were checked offline. The embedded program matches the readable Python copy. No new-server import, transcription, email send or live deployment was performed to validate this public template.

References: [n8n import/export](https://docs.n8n.io/build/manage-workflows/export-and-import.md), [Execute Command](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/), [full instance backup](https://github.com/n8n-io/n8n-docs/blob/main/docs/deploy/host-n8n/keep-n8n-running/backup-and-restore.md).

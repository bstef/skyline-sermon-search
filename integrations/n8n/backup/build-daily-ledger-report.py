"""Build a Resend email from the existing server ledger; never call Groq or send mail."""
import json
import os
import sqlite3
from html import escape
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import urlopen
from zoneinfo import ZoneInfo


def render_email(now, today, rolling, monthly, done, total, remaining, completed,
                 published, runs, failures, deferred, warnings, billing, source):
    """Table layout and inline styles keep the report readable in email clients."""
    e = lambda value: escape(str(value), quote=True)
    cost = lambda seconds: f'${seconds / 3600 * .04:.2f}'
    progress = max(0, min(100, done / total * 100)) if total else 0
    has_alert = bool(warnings)
    status_color, status_bg = ('#92400e', '#fffbeb') if has_alert else ('#166534', '#f0fdf4')
    status_title = 'A few things to review' if has_alert else 'Everything looks on track'
    items = ''.join(f'<li style="margin:0 0 8px;">{e(w)}</li>' for w in dict.fromkeys(warnings))
    status_body = f'<ul style="margin:12px 0 0;padding-left:20px;">{items}</ul>' if has_alert else '<p style="margin:8px 0 0;">No problems detected in the available ledger and run history.</p>'
    def card(label, value, detail, color):
        return f'<td class="card" width="50%" valign="top" style="padding:8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;border:1px solid #e3eaf2;border-radius:12px;"><tr><td style="padding:22px;"><div style="font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#64748b;">{e(label)}</div><div style="font-size:36px;line-height:44px;font-weight:700;color:{color};margin:7px 0;">{e(value)}</div><div style="font-size:13px;line-height:20px;color:#64748b;">{e(detail)}</div></td></tr></table></td>'
    rows = [
        ('Audio processed today', f'{today[0]/3600:.2f} hours', 'Reserved audio, including uncertain requests'),
        ('Month-to-date estimate', cost(monthly[0]), 'UTC calendar month · not an invoice'),
        ('Rolling 24-hour usage', f'{rolling[0]/3600:.2f} / 7.50 hours', f'{rolling[2]} / 12 distinct sermons'),
        ('Daily cost ceiling', '$0.30 equivalent', '7.5 audio hours × $0.04 per hour'),
        ('Recorded runs', str(runs), f'{failures} failed · {deferred} deferred'),
    ]
    usage_rows = ''.join(f'<tr><td style="padding:15px 0;border-bottom:1px solid #e8edf3;color:#475569;font-size:14px;vertical-align:top;">{e(label)}</td><td align="right" style="padding:15px 0 15px 12px;border-bottom:1px solid #e8edf3;vertical-align:top;"><div style="font-size:14px;font-weight:700;color:#142c46;">{e(value)}</div><div style="font-size:11px;line-height:17px;color:#64748b;margin-top:4px;">{e(detail)}</div></td></tr>' for label, value, detail in rows)
    date_label = now.strftime('%B %d, %Y').replace(' 0', ' ')
    time_label = now.strftime('%I:%M %p').lstrip('0') + ' Eastern'
    period_note = 'Run-history counts begin at about 8:37 a.m. today.' if now.date().isoformat() == '2026-10-28' else 'Activity since midnight Eastern. Usage caps use a rolling 24-hour window.'
    plan = str(billing.get('mode', 'unverified')).capitalize()
    observed = billing.get('verified_at', 'unavailable')
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skyline Echo daily report</title>
<style>@media screen and (max-width:600px){{.outer{{padding:16px 8px!important}}.pad{{padding:24px!important}}.card{{display:block!important;width:auto!important}}.title{{font-size:28px!important;line-height:34px!important}}}}</style></head>
<body style="margin:0;padding:0;background:#edf2f7;font-family:Arial,Helvetica,sans-serif;color:#142c46;">
<div style="display:none;font-size:1px;line-height:1px;color:#edf2f7;max-height:0;max-width:0;opacity:0;overflow:hidden;">{published} published today · {remaining} remaining · {cost(today[0])} estimated audio cost</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf2f7;"><tr><td class="outer" align="center" style="padding:32px 16px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e0e7ef;border-radius:18px;overflow:hidden;">
<tr><td style="height:5px;background:#27aae1;font-size:1px;line-height:5px;">&nbsp;</td></tr>
<tr><td class="pad" style="padding:34px 36px 30px;background:#112b46;">
<div style="font-size:12px;letter-spacing:2.5px;font-weight:700;color:#62d4cc;">SKYLINE ECHO</div>
<h1 class="title" style="margin:15px 0 10px;font-size:32px;line-height:39px;font-weight:700;color:#ffffff;">Your archive, moving forward.</h1>
<p style="margin:0;color:#b9cddd;font-size:14px;line-height:22px;">Daily transcription &amp; cost report<br>{e(date_label)} <span style="color:#7794ac;">&nbsp;·&nbsp;</span> {e(time_label)}</p>
</td></tr>
<tr><td class="pad" style="padding:28px 28px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
{card('Published today', published, f'{completed} completed · {runs} recorded runs', '#087f8c')}
{card('Estimated cost today', cost(today[0]), 'Audio equivalent · not a bill', '#1667a4')}
</tr></table></td></tr>
<tr><td class="pad" style="padding:20px 36px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:18px;font-weight:700;">Archive progress</td><td align="right" style="font-size:15px;font-weight:700;color:#087f8c;">{progress:.1f}%</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 12px;background:#e7edf4;border-radius:8px;"><tr><td width="{progress:.2f}%" style="height:10px;background:#159e9a;border-radius:8px;font-size:1px;line-height:10px;">&nbsp;</td><td style="height:10px;font-size:1px;line-height:10px;">&nbsp;</td></tr></table>
<p style="margin:0;font-size:14px;line-height:23px;color:#475569;"><strong style="color:#142c46;">{done} of {total}</strong> sermons transcribed &nbsp;·&nbsp; <strong style="color:#142c46;">{remaining}</strong> remaining</p>
<p style="margin:5px 0 0;font-size:12px;line-height:20px;color:#64748b;">About {(remaining+11)//12} days at up to 12/day, plus pauses and new sermons.<br>Source: {e(source)}.</p>
</td></tr>
<tr><td class="pad" style="padding:0 36px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{status_bg};border-radius:12px;"><tr><td style="padding:20px;color:{status_color};font-size:13px;line-height:21px;"><strong style="font-size:15px;">{status_title}</strong>{status_body}</td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 36px 28px;"><h2 style="font-size:18px;margin:0 0 4px;">Usage &amp; cost</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{usage_rows}</table>
<p style="font-size:11px;line-height:18px;color:#64748b;margin:14px 0 0;">{e(period_note)} Costs use reserved audio at $0.04/hour and include failed or uncertain requests. Cached audio chunks are reused.</p></td></tr>
<tr><td class="pad" style="padding:0 36px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;border-radius:12px;"><tr><td style="padding:20px;"><div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#64748b;">GROQ BILLING CHECK</div><p style="font-size:14px;line-height:22px;margin:8px 0;color:#142c46;"><strong>{e(plan)} plan</strong> at last verification · {e(observed)}</p><p style="font-size:12px;line-height:20px;margin:0;color:#64748b;">The October 28 dashboard showed $1.38 in projected usage, not charges. This report estimates audio costs; it cannot verify a current invoice or billing change.</p></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 36px 34px;"><a href="https://app.example.com" style="display:inline-block;padding:13px 21px;background:#087f8c;border-radius:8px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Open Skyline Echo &rarr;</a><p style="margin:18px 0 0;font-size:12px;line-height:22px;"><a href="https://console.groq.com/settings/organization/usage" style="color:#1667a4;text-decoration:underline;">Groq usage</a> &nbsp;&nbsp;·&nbsp;&nbsp; <a href="https://n8n.example.com/workflow/REPLACE_WORKFLOW_ID/executions" style="color:#1667a4;text-decoration:underline;">Workflow runs</a></p></td></tr>
</table><p style="margin:20px 0 0;font-size:11px;line-height:18px;color:#718096;">SKYLINE ECHO &nbsp;·&nbsp; Sent through Resend<br>Daily report at 11:50 p.m. Eastern · Runs independently on the server</p>
</td></tr></table></body></html>'''


def build(root=Path('/var/lib/skyline-echo'), now=None, fetch_stats=None):
    now = now or datetime.now(ZoneInfo('America/New_York'))
    now = now.astimezone(ZoneInfo('America/New_York'))
    test = os.getenv('SKYLINE_REPORT_TEST') == '1'
    key = 'setup-resend-recipients-v3' if test else now.date().isoformat()
    folder = root / 'email-reports'
    folder.mkdir(mode=0o700, exist_ok=True)
    if (folder / (key + '.sent.json')).exists():
        return {'skip': True, 'report_key': key, 'reason': 'already_accepted_by_resend'}
    payload_file = folder / (key + '.json')
    if payload_file.exists():
        return json.loads(payload_file.read_text())

    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = midnight + timedelta(days=1)
    month = now.astimezone(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    def connect(name):
        return sqlite3.connect('file:' + str(root / name) + '?mode=ro', uri=True)
    with connect('groq-audio-budget.sqlite3') as db:
        def audio(since, until):
            return db.execute('SELECT coalesce(sum(seconds),0),count(*),count(DISTINCT episode_id) FROM audio_requests WHERE requested_at>=? AND requested_at<?', (since, until)).fetchone()
        today = audio(midnight.timestamp(), min(now.timestamp(), tomorrow.timestamp()))
        rolling = audio(now.timestamp() - 86400, now.timestamp())
        monthly = audio(month.timestamp(), now.timestamp())
        lifetime = audio(0, now.timestamp())
        cooldown = db.execute('SELECT until FROM cooldown WHERE id=1').fetchone()[0]
    with connect('sermons.sqlite3') as db:
        local_total = db.execute('SELECT count(*) FROM episodes').fetchone()[0]
        local_done = db.execute('SELECT count(DISTINCT episode_id) FROM passages').fetchone()[0]
    warnings = []
    if fetch_stats is None:
        def fetch_stats():
            with urlopen('https://app.example.com/api/stats', timeout=20) as response:
                return json.load(response)
    try:
        public = fetch_stats()
        total, done = int(public['episodes']), int(public['indexed'])
        coverage_source = 'published website'
    except Exception:
        total, done = local_total, local_done
        coverage_source = 'server transcription database'
    remaining = max(0, total - done)
    runs = []
    history = root / 'run-history.jsonl'
    if history.exists():
        for line in history.read_text().splitlines():
            try:
                row = json.loads(line)
                if midnight.timestamp() <= row['timestamp'] < tomorrow.timestamp():
                    runs.append(row['report'])
            except (ValueError, KeyError, TypeError):
                warnings.append('An incomplete run-history record was ignored.')
    completed_ids = {e['episode_id'] for r in runs for e in r.get('completed', [])}
    published_ids = {e['episode_id'] for r in runs for e in r.get('publishing', []) if e.get('status') == 'published'}
    failures = sum(r.get('status') in ('failed', 'publication_failed') for r in runs)
    deferred = sum(r.get('status') == 'deferred' for r in runs)
    if failures:
        warnings.append(f'{failures} recorded transcription/publication failures today.')
    if cooldown > now.timestamp():
        warnings.append('Groq rate-limit cooldown is active until ' + datetime.fromtimestamp(cooldown, now.tzinfo).isoformat(timespec='minutes'))
    if rolling[0] > 27000 or rolling[2] > 12:
        warnings.append('Rolling-day usage exceeds the configured safety cap; investigate.')
    if local_done > done and coverage_source == 'published website':
        warnings.append(f'{local_done - done} locally transcribed sermons are not yet reflected in published totals.')
    if remaining and not completed_ids:
        warnings.append('No completed sermons are recorded today; check run history and quota deferrals.')
    # This is a verified historical observation, never an assertion of today's billing state.
    billing = {'verified_at': '2026-10-28', 'mode': 'free', 'projected_month_usd': 1.38}
    billing_file = root / 'groq-dashboard-status.json'
    if billing_file.exists():
        try:
            billing = json.loads(billing_file.read_text())
        except ValueError:
            warnings.append('Saved Groq dashboard observation is invalid.')
    if billing.get('mode') != 'free':
        warnings.append('Groq is no longer recorded as free; review billing immediately.')
    if now.date().isoformat() not in str(billing.get('verified_at', '')):
        warnings.append('Current Groq billing status is unverified; last dashboard observation is dated ' + str(billing.get('verified_at')) + '.')
    dollars = lambda seconds: seconds / 3600 * 0.04
    subject = ('[Setup test] ' if test else '') + 'Skyline Echo daily transcription & cost — ' + now.date().isoformat()
    text = '\n'.join([
        'Skyline Echo — transcription and Groq usage summary',
        'Report generated: ' + now.isoformat(timespec='minutes'),
        'Period: today since midnight America/New_York; run-history logging began October 28 at about 8:37 a.m.',
        '',
        f'Today: {len(completed_ids)} completed and {len(published_ids)} published sermons in {len(runs)} recorded runs.',
        f'Today reserved audio: {today[0]/3600:.2f} hours in {today[1]} API request reservations.',
        f'Today equivalent transcription cost: ${dollars(today[0]):.4f}.',
        f'Rolling 24h: {rolling[2]}/12 distinct sermons; {rolling[0]/3600:.2f}/7.50 audio hours; equivalent ${dollars(rolling[0]):.4f}/$0.30 cap.',
        f'UTC calendar month equivalent cost: ${dollars(monthly[0]):.4f}; ledger lifetime equivalent: ${dollars(lifetime[0]):.4f}.',
        f'Archive ({coverage_source}): {done}/{total} transcribed; {remaining} remaining.',
        f'ETA at up to 12/day: approximately {(remaining+11)//12} days, plus pauses/new sermons.',
        f'Recorded failures: {failures}; deferred runs: {deferred}.',
        '',
        'COST LABELS: All calculated dollars above are conservative estimates at USD 0.04/audio hour, not Groq invoices. Reservations include failed/uncertain requests and retries; cached chunks are not submitted again.',
        'Groq dashboard last verified: ' + str(billing.get('verified_at')) + '; recorded plan: ' + str(billing.get('mode')) + '; projected month amount at that observation: $' + str(billing.get('projected_month_usd', 'unavailable')) + '.',
        'On October 28 the Groq dashboard explicitly stated projected cost was not billed. This server report cannot directly verify current billing; check the dashboard or the separate desktop monitor.',
        'Free account provider limits verified October 28: 8 audio hours/day and 2/hour. Our caps: 7.5/day, 1.5/hour and 12 distinct sermons/rolling day.',
        '',
        'ATTENTION: ' + (' | '.join(dict.fromkeys(warnings)) if warnings else 'No problems detected in the available ledger and run history.'),
        '',
        'Groq: https://console.groq.com/settings/organization/usage',
        'n8n: https://n8n.example.com/workflow/REPLACE_WORKFLOW_ID/executions',
        'Archive: https://app.example.com',
        '',
        'Sent through Resend. Gmail is not used as the sending service.',
    ])
    result = {'skip': False, 'report_key': key, 'idempotency_key': 'skyline-echo/daily/' + key,
              'payload': {'from': 'Skyline Echo <reports@example.com>', 'to': ['recipient-one@example.com', 'recipient-two@example.com'],
                          'subject': subject, 'text': text,
                          'html': render_email(now, today, rolling, monthly, done, total, remaining,
                                               len(completed_ids), len(published_ids), len(runs),
                                               failures, deferred, warnings, billing, coverage_source)}}
    temporary = payload_file.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2))
    temporary.replace(payload_file)
    return result


if __name__ == '__main__':
    print(json.dumps(build()))

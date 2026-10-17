"""Bounded, locked n8n runner. Default configuration only previews metadata."""
import argparse
from datetime import date, timedelta
import fcntl
import json
import os
from pathlib import Path
import sys

from . import core
from .budget import AudioBudget, BudgetDeferred
from .transcription import atomic_json, model_name, transcribe, transcription_plan


def run(config_path, force_preview=False):
    config = json.loads(Path(config_path).read_text())
    for name, default in [('dry_run', True), ('include_archive', False)]:
        if not isinstance(config.get(name, default), bool):
            raise ValueError(f'{name} must be a JSON boolean.')
    limit = config.get('max_episodes', 1)
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError('max_episodes must be an integer between 1 and 20.')
    directory = Path(config['data_dir']).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    os.environ['SERMON_DB'] = str(directory / 'sermons.sqlite3')
    os.environ['TRANSCRIPT_CACHE_DIR'] = str(directory / 'transcripts')
    os.environ['GROQ_TRANSCRIPTION_MODEL'] = config.get('model', 'whisper-large-v3-turbo')
    model_name()  # Reject invalid models even when there are no pending episodes.
    preview = force_preview or config.get('dry_run', True)
    budget_settings = config.get('audio_budget')
    budget = None
    if budget_settings is not None:
        if not isinstance(budget_settings, dict):
            raise ValueError('audio_budget must be an object.')
        budget = AudioBudget(directory / 'groq-audio-budget.sqlite3', budget_settings)
        os.environ['SKYLINE_AUDIO_BUDGET_DB'] = str(budget.path)
        os.environ['SKYLINE_AUDIO_BUDGET_SETTINGS'] = json.dumps(budget_settings)
    else:
        os.environ.pop('SKYLINE_AUDIO_BUDGET_DB', None)
        os.environ.pop('SKYLINE_AUDIO_BUDGET_SETTINGS', None)
    recent_days = config.get('priority_recent_days', 0)
    if type(recent_days) is not int or not 0 <= recent_days <= 90:
        raise ValueError('priority_recent_days must be an integer between 0 and 90.')
    recent_since = (date.today()-timedelta(days=recent_days)).isoformat() if recent_days else '9999-12-31'

    publishing = config.get('publishing', {})
    if not isinstance(publishing, dict) or any(type(publishing.get(key, default)) is not bool for key, default in [('enabled', False), ('dry_run', True)]):
        raise ValueError('publishing.enabled and publishing.dry_run must be JSON booleans.')
    with (directory / 'run.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'busy', 'message': 'Another run is already active.'}
        core.init()
        synced = core.sync()  # RSS metadata only; no audio or AI request.
        boundary_file = directory / 'first-run.json'
        if boundary_file.exists():
            boundary = json.loads(boundary_file.read_text())['since']
        else:
            boundary = (date.today() - timedelta(days=14)).isoformat()
            atomic_json(boundary_file, {'since': boundary})
        since = config.get('since') or boundary
        date.fromisoformat(since)
        if config.get('include_archive', False):
            since = '0001-01-01'
        with core.database() as db:
            episodes = db.execute('''SELECT e.id FROM episodes e
                WHERE e.date >= ? AND e.date <= ?
                AND NOT EXISTS (SELECT 1 FROM passages p WHERE p.episode_id=e.id)
                ORDER BY CASE WHEN e.date>=? THEN 0 ELSE 1 END, e.date, e.id LIMIT ?''', (since, date.today().isoformat(), recent_since, limit)).fetchall()
        plans = [transcription_plan(e['id']) for e in episodes]
        report = {'status': 'preview' if preview else 'complete', 'dry_run': preview,
                  'synced': synced, 'since': since, 'max_episodes': limit,
                  'selected': plans, 'completed': []}
        if not preview:
            for plan in plans:
                try:
                    count = transcribe(plan['episode_id'])
                except BudgetDeferred as deferred:
                    report.update(status='deferred', reason=deferred.reason, retry_after_epoch=deferred.retry_at)
                    break
                except Exception:
                    report['status'] = 'failed'
                    report['failed_episode_id'] = plan['episode_id']
                    atomic_json(directory / 'last-run.json', report)
                    raise
                report['completed'].append({'episode_id': plan['episode_id'], 'passages': count,
                    'transcript': str(Path(plan['cache_directory']) / 'transcript.json')})
            if publishing.get('enabled', False):
                from .publishing import publish_pending
                try:
                    report['publishing'] = publish_pending(publishing['endpoint'], 20, publishing.get('dry_run', True))
                except Exception:
                    report['status'] = 'publication_failed'
                    atomic_json(directory / 'last-run.json', report)
                    raise
        if budget:
            report['audio_budget'] = budget.summary()
        atomic_json(directory / 'last-run.json', report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true', help='Force preview, regardless of config')
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.config, args.dry_run)))
    except Exception as error:
        # Provider exception bodies may include sensitive request data. Keep n8n logs minimal.
        print(f'Skyline runner failed ({type(error).__name__}). Check configuration, network, Groq limits and last-run.json.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

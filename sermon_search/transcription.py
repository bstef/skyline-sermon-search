"""Groq transcription is explicit; importing this module never starts processing."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import urlopen

from . import core

GROQ_URL = 'https://api.groq.com/openai/v1'
DEFAULT_MODEL = 'whisper-large-v3'
SUPPORTED_MODELS = {DEFAULT_MODEL, 'whisper-large-v3-turbo'}
PROMPT = 'A Christian sermon at Skyline Church in Bloomfield, New Jersey. Biblical names and Scripture references.'


def model_name():
    model = os.getenv('GROQ_TRANSCRIPTION_MODEL', DEFAULT_MODEL)
    if model not in SUPPORTED_MODELS:
        raise ValueError('GROQ_TRANSCRIPTION_MODEL must be whisper-large-v3 or whisper-large-v3-turbo.')
    return model


def transcription_client():
    key = os.getenv('GROQ_API_KEY', '').strip()
    if not key:
        raise RuntimeError('Set GROQ_API_KEY in the backend environment before transcribing.')
    # Reuse the existing SDK with Groq's officially supported compatibility endpoint.
    # This client is separate from core.client(), which handles OpenAI embeddings.
    from openai import OpenAI
    return OpenAI(api_key=key, base_url=GROQ_URL, timeout=120, max_retries=0 if os.getenv('SKYLINE_AUDIO_BUDGET_DB') else 2)


def transcription_plan(eid):
    with core.database() as db:
        episode = db.execute('SELECT * FROM episodes WHERE id=?', (eid,)).fetchone()
    if episode is None:
        raise ValueError('Unknown episode ID. Sync the podcast feed first.')
    model = model_name()
    cache_root = Path(os.getenv('TRANSCRIPT_CACHE_DIR', str(Path(os.getenv('SERMON_DB', 'data/sermons.sqlite3')).parent / 'transcripts')))
    # Separate checkpoints by provider, model, and processing settings.
    cache = cache_root / eid / 'groq' / model / 'flac-16k-segments-v1'
    return {
        'episode_id': eid, 'title': episode['title'], 'audio_url': episode['audio_url'],
        'provider': 'groq', 'model': model, 'cache_directory': str(cache),
        'api_key_configured': bool(os.getenv('GROQ_API_KEY', '').strip()),
        'ffmpeg_available': bool(shutil.which('ffmpeg')),
        'ffprobe_available': bool(shutil.which('ffprobe')),
        'chunk_minutes': 10, 'starts_processing': False,
    }


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def valid_segments(result):
    segments = result.get('segments')
    if not isinstance(segments, list):
        raise ValueError('Groq response did not include timestamped segments.')
    # Silence can yield empty or zero-length segments; do not add those to the index.
    cleaned = [dict(start=s['start'], end=s['end'], text=s['text']) for s in segments
               if s['end'] > s['start'] and str(s['text']).strip()]
    core.chunk_segments(cleaned)  # Check finite, ordered timestamps before caching.
    return cleaned


def chunk_duration(path):
    """Count decoded samples: segmented FLAC duration metadata is unreliable."""
    frames = json.loads(subprocess.check_output(['ffprobe', '-v', 'error',
        '-select_streams', 'a:0', '-show_frames', '-show_entries', 'frame=nb_samples',
        '-of', 'json', str(path)]))
    # The splitter explicitly resamples every part to mono 16 kHz. Container
    # duration can be N/A or retain the original file's duration on the last part.
    samples = sum(int(frame.get('nb_samples', 0)) for frame in frames.get('frames', []))
    if samples <= 0:
        raise RuntimeError('Unable to determine the audio chunk duration.')
    return samples / 16000


def transcribe(eid):
    plan = transcription_plan(eid)
    if not plan['ffmpeg_available'] or not plan['ffprobe_available']:
        raise RuntimeError('Install ffmpeg and ffprobe before transcribing.')
    model = plan['model']
    # Validate credentials before downloading any audio. No fallback to OpenAI.
    api = transcription_client()
    cache = Path(plan['cache_directory'])
    cache.mkdir(parents=True, exist_ok=True)
    budget = None
    if os.getenv('SKYLINE_AUDIO_BUDGET_DB'):
        from .budget import AudioBudget
        budget = AudioBudget(os.environ['SKYLINE_AUDIO_BUDGET_DB'], json.loads(os.environ['SKYLINE_AUDIO_BUDGET_SETTINGS']))
    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp) / 'source.audio'
        with urlopen(plan['audio_url'], timeout=60) as response, source.open('wb') as target:
            shutil.copyfileobj(response, target)
        # Mono 16 kHz FLAC avoids MP3 padding drift and remains below 25 MB per chunk.
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(source),
            '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-c:a', 'flac',
            '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1',
            str(Path(temp) / 'part-%04d.flac')], check=True)
        parts = sorted(Path(temp).glob('part-*.flac'))
        if not parts:
            raise RuntimeError('Audio splitting produced no files.')
        segments, offset = [], 0.0
        for part in parts:
            duration = chunk_duration(part)
            fingerprint = hashlib.sha256(part.read_bytes()).hexdigest()
            checkpoint = cache / (fingerprint + '.json')
            if checkpoint.exists():
                result = json.loads(checkpoint.read_text())
                cleaned = valid_segments(result)
            else:
                raw_checkpoint = cache / (fingerprint + '.raw.json')
                if raw_checkpoint.exists():
                    result = json.loads(raw_checkpoint.read_text())
                else:
                    if budget:
                        budget.reserve(duration, eid, model, fingerprint)
                    try:
                        with part.open('rb') as audio:
                            result = api.audio.transcriptions.create(model=model, file=audio,
                                language='en', response_format='verbose_json',
                                timestamp_granularities=['segment'], temperature=0,
                                prompt=PROMPT).model_dump()
                    except Exception as error:
                        if budget and getattr(error, 'status_code', None) == 429:
                            from .budget import BudgetDeferred
                            # Shared account usage may exhaust a provider limit
                            # sooner than our ledger. Stop until the next day.
                            budget.pause(86400)
                            raise BudgetDeferred('groq_rate_limit', __import__('time').time()+86400) from None
                        raise
                    atomic_json(raw_checkpoint, result)
                cleaned = valid_segments(result)
                atomic_json(checkpoint, result)
            segments.extend({'start': offset+s['start'], 'end': offset+s['end'], 'text': s['text']} for s in cleaned)
            offset += duration
        # Validation/import is transactional; a failed run preserves the old transcript.
        count = core.import_transcript(eid, segments)
        atomic_json(cache / 'transcript.json', {
            'provider': 'groq', 'model': model, 'episode_id': eid, 'segments': segments,
        })
        return count

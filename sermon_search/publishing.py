"""Publish saved transcripts; never invokes a transcription provider."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import core
from .transcription import atomic_json, transcription_plan


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the publishing credential to a redirect destination.


def send(payload, endpoint):
    url = urlparse(endpoint)
    if url.scheme != 'https' or not url.netloc or url.username or url.password or url.query or url.fragment:
        raise ValueError('Use an HTTPS publishing endpoint without credentials or query parameters.')
    token = os.getenv('SKYLINE_PUBLISH_TOKEN', '').strip()
    if not token:
        token_file = Path(os.getenv('SKYLINE_PUBLISH_TOKEN_FILE', '/etc/skyline-echo-publish.token'))
        if token_file.exists():
            if token_file.stat().st_mode & 0o077:
                raise RuntimeError('Publishing token file must have permissions 600 or stricter.')
            token = token_file.read_text().strip()
    if not token:
        raise RuntimeError('Configure SKYLINE_PUBLISH_TOKEN or a private publishing token file.')
    request = Request(endpoint, data=json.dumps(payload).encode(), method='POST', headers={
        'Authorization': f'Bearer {token}', 'Content-Type': 'application/json',
        'User-Agent': 'SkylineEchoPublisher/1.0'})
    with build_opener(NoRedirect()).open(request, timeout=60) as response:
        result = json.loads(response.read(65536))
    expected = {'validated'} if payload.get('dry_run', True) else {'published', 'already_published'}
    if result.get('status') not in expected or result.get('episode_id') != payload['episode']['id']:
        raise RuntimeError('Unexpected publication response.')
    return result


def publish_pending(endpoint, limit=1, dry_run=True):
    with core.database() as db:
        episodes = [dict(row) for row in db.execute('''SELECT e.* FROM episodes e
            WHERE EXISTS (SELECT 1 FROM passages p WHERE p.episode_id=e.id)
            ORDER BY e.date,e.id''').fetchall()]
    results = []
    for episode in episodes:
        plan = transcription_plan(episode['id'])
        transcript_path = Path(plan['cache_directory']) / 'transcript.json'
        if not transcript_path.exists():
            # A changed model must not turn overlapping search passages into a new transcript.
            root = Path(os.getenv('TRANSCRIPT_CACHE_DIR', 'data/transcripts')) / episode['id']
            saved = list(root.glob('groq/*/flac-16k-segments-v1/transcript.json'))
            if not saved:
                raise RuntimeError('Missing original transcript JSON; publish manually imported transcripts explicitly.')
            transcript_path = max(saved, key=lambda p: p.stat().st_mtime_ns)
        segments = json.loads(transcript_path.read_text())['segments']
        payload = {'episode': episode, 'segments': segments, 'dry_run': dry_run}
        source_hash = hashlib.sha256(json.dumps({'endpoint': endpoint, 'episode': episode, 'segments': segments}, sort_keys=True).encode()).hexdigest()
        marker = Path(os.getenv('TRANSCRIPT_CACHE_DIR', 'data/transcripts')) / episode['id'] / 'publication.json'
        if marker.exists() and json.loads(marker.read_text()).get('source_hash') == source_hash:
            continue
        result = send(payload, endpoint)
        if not dry_run:
            marker.parent.mkdir(parents=True, exist_ok=True)
            atomic_json(marker, {'source_hash': source_hash, 'response': result})
        results.append(result)
        if len(results) >= limit:
            break
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--file', type=Path, required=True, help='JSON containing episode metadata and segments')
    parser.add_argument('--commit', action='store_true', help='Actually publish; omitted means validation only')
    args = parser.parse_args()
    payload = json.loads(args.file.read_text())
    payload['dry_run'] = not args.commit
    try:
        print(json.dumps(send(payload, args.endpoint)))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error_type': type(error).__name__}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()

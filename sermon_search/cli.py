"""Explicit offline operations; no ingestion or paid processing on public routes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import urlopen
from . import core


def transcribe(eid):
    api = core.client()
    with core.database() as db:
        episode = db.execute('SELECT * FROM episodes WHERE id=?',(eid,)).fetchone()
    if episode is None:
        raise ValueError('Unknown episode ID')
    if not shutil.which('ffmpeg'):
        raise RuntimeError('Install ffmpeg to split long podcast audio.')
    cache = Path('data/transcripts') / eid
    cache.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp) / 'source.audio'
        with urlopen(episode['audio_url'],timeout=60) as response, source.open('wb') as target:
            shutil.copyfileobj(response,target)
        pattern = str(Path(temp) / 'part-%04d.mp3')
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(source),
            '-map','0:a:0','-ac','1','-ar','16000','-b:a','64k','-f','segment',
            '-segment_time','600','-reset_timestamps','1',pattern],check=True)
        segments = []
        offset = 0.0
        for part in sorted(Path(temp).glob('part-*.mp3')):
            # Duration of preceding actual file avoids assuming exact split times.
            duration = float(subprocess.check_output(['ffprobe','-v','error','-show_entries',
                'format=duration','-of','default=noprint_wrappers=1:nokey=1',str(part)]))
            fingerprint = hashlib.sha256(part.read_bytes()).hexdigest()
            checkpoint = cache / (fingerprint+'.json')
            if checkpoint.exists():
                result = json.loads(checkpoint.read_text())
            else:
                with part.open('rb') as audio:
                    result = api.audio.transcriptions.create(model='whisper-1',file=audio,
                        language='en',response_format='verbose_json',timestamp_granularities=['segment']).model_dump()
                checkpoint.write_text(json.dumps(result))
            for s in result['segments']:
                if s['end'] > s['start']:
                    segments.append({'start':offset+s['start'],'end':offset+s['end'],'text':s['text']})
            offset += duration
        transcript = cache / 'transcript.json'
        transcript.write_text(json.dumps({'segments':segments},indent=2))
        return core.import_transcript(eid,segments)


def main():
    parser = argparse.ArgumentParser(description='Manage Skyline podcast search')
    commands = parser.add_subparsers(dest='command',required=True)
    commands.add_parser('sync',help='Import podcast metadata; no AI calls')
    commands.add_parser('list',help='List episode IDs and transcript status')
    commands.add_parser('embed',help='Paid API: embed passages that need indexing')
    imp = commands.add_parser('import',help='Import timestamped JSON transcript')
    imp.add_argument('episode_id'); imp.add_argument('file',type=Path)
    trans = commands.add_parser('transcribe',help='Paid API: transcribe one episode, with resumable chunk cache')
    trans.add_argument('episode_id')
    args = parser.parse_args()
    core.init()
    if args.command=='sync': print(f'Imported {core.sync()} podcast episodes.')
    elif args.command=='list':
        for e in core.episodes(): print(e['id'],e['date'],f"[{e['passages']} passages]",e['title'])
    elif args.command=='import': print(f"Indexed {core.import_transcript(args.episode_id,json.loads(args.file.read_text())['segments'])} passages.")
    elif args.command=='embed': print(f'Embedded {core.embed_pending()} passages.')
    elif args.command=='transcribe': print(f'Indexed {transcribe(args.episode_id)} passages.')

if __name__=='__main__': main()

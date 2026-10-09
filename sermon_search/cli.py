"""Explicit offline operations; no ingestion or paid processing on public routes."""
import argparse
import json
from pathlib import Path
from . import core
from .transcription import transcribe, transcription_plan


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
    trans.add_argument('--dry-run', action='store_true', help='Show Groq configuration without downloads or API calls')
    args = parser.parse_args()
    core.init()
    if args.command=='sync': print(f'Imported {core.sync()} podcast episodes.')
    elif args.command=='list':
        for e in core.episodes(): print(e['id'],e['date'],f"[{e['passages']} passages]",e['title'])
    elif args.command=='import': print(f"Indexed {core.import_transcript(args.episode_id,json.loads(args.file.read_text())['segments'])} passages.")
    elif args.command=='embed': print(f'Embedded {core.embed_pending()} passages.')
    elif args.command=='transcribe':
        if args.dry_run:
            print(json.dumps(transcription_plan(args.episode_id), indent=2))
        else:
            print(f'Indexed {transcribe(args.episode_id)} passages with Groq.')

if __name__=='__main__': main()

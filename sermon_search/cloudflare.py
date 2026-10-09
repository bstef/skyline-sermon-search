"""Export the canonical local archive for D1 / optional Vectorize, without AI calls."""
import hashlib
import json
from pathlib import Path
from . import core


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def export_archive(destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with core.database() as db:
        episodes = db.execute('SELECT * FROM episodes ORDER BY id').fetchall()
        passages = db.execute('SELECT * FROM passages ORDER BY id').fetchall()
    sql = ['-- Canonical archive export. No transcription or embedding requests.']
    for row in episodes:
        sql.append('INSERT INTO episodes VALUES(' + ','.join(literal(v) for v in row) +
                   ') ON CONFLICT(id) DO UPDATE SET title=excluded.title,date=excluded.date,'
                   'audio_url=excluded.audio_url,description=excluded.description,link=excluded.link;')
    # Replace only episodes with actual local transcripts. Metadata-only copies
    # cannot erase transcripts already published to D1.
    for eid in sorted({row['episode_id'] for row in passages}):
        sql.append('DELETE FROM passages WHERE episode_id=' + literal(eid) + ';')
    for row in passages:
        sql.append('INSERT INTO passages(id,episode_id,start,end,text,embedding,model) VALUES(' +
                   ','.join(literal(v) for v in row) + ');')
    destination.write_text('\n'.join(sql) + '\n')
    vectors = destination.with_suffix('.ndjson')
    with vectors.open('w') as out:
        for row in passages:
            if row['model'] == core.MODEL and row['embedding']:
                out.write(json.dumps({'id': str(row['id']) + '-' + hashlib.sha256(row['text'].encode()).hexdigest()[:16], 'values': json.loads(row['embedding'])}) + '\n')
    return {'episodes': len(episodes), 'passages': len(passages),
            'sql': str(destination), 'vectors': str(vectors)}

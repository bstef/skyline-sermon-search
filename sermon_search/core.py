"""Storage and retrieval. Podcast ingestion is separate from public search."""
from .speakers import speaker_credit
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
from functools import lru_cache
from urllib.parse import urlparse
from urllib.request import urlopen
import xml.etree.ElementTree as ET

import numpy as np

FEED = 'https://anchor.fm/s/deceb88/podcast/rss'
MODEL = 'text-embedding-3-small'
DIMENSIONS = 512

@contextmanager
def database():
    path = Path(os.getenv('SERMON_DB', 'data/sermons.sqlite3'))
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def init():
    with database() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS episodes (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL,
          audio_url TEXT NOT NULL, description TEXT NOT NULL, link TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS passages (
          id INTEGER PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
          start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL,
          embedding TEXT, model TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(text, content='passages', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS passage_insert AFTER INSERT ON passages BEGIN
          INSERT INTO passages_fts(rowid,text) VALUES(new.id,new.text); END;
        CREATE TRIGGER IF NOT EXISTS passage_delete AFTER DELETE ON passages BEGIN
          INSERT INTO passages_fts(passages_fts,rowid,text) VALUES('delete',old.id,old.text); END;
        CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
        INSERT OR IGNORE INTO revision VALUES(1,0);
        ''')
        columns = {r['name'] for r in db.execute('PRAGMA table_info(episodes)')}
        for column in ('speaker', 'speaker_source'):
            if column not in columns:
                db.execute(f"ALTER TABLE episodes ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")

def safe_url(url):
    return url if urlparse(url).scheme in ('https', 'http') else ''

def ingest_xml(xml):
    root = ET.fromstring(xml)
    items = root.findall('./channel/item')
    count = 0
    with database() as db:
        for item in items:
            enclosure = item.find('enclosure')
            if enclosure is None or not safe_url(enclosure.get('url','')):
                continue
            audio = enclosure.get('url')
            guid = item.findtext('guid') or audio
            eid = hashlib.sha256(guid.encode()).hexdigest()[:20]
            date = parsedate_to_datetime(item.findtext('pubDate')).date().isoformat()
            description = re.sub('<[^>]+>', ' ', item.findtext('description') or '').strip()
            speaker, speaker_source = speaker_credit(item)
            db.execute('''INSERT INTO episodes(id,title,date,audio_url,description,link,speaker,speaker_source) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
              title=excluded.title,date=excluded.date,audio_url=excluded.audio_url,
              description=excluded.description,link=excluded.link,
              speaker=excluded.speaker,speaker_source=excluded.speaker_source''',
              (eid, item.findtext('title') or 'Untitled sermon', date, audio, description,
               safe_url(item.findtext('link') or ''), speaker, speaker_source))
            count += 1
    return count

def sync():
    with urlopen(FEED, timeout=30) as response:
        return ingest_xml(response.read())

def chunk_segments(segments):
    """Overlap one segment so ideas at boundaries remain retrievable."""
    cleaned = []
    previous = -1
    for s in segments:
        start, end = float(s['start']), float(s['end'])
        text = str(s['text']).strip()
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or start < previous:
            raise ValueError('Segments must be ordered and have finite, positive time ranges.')
        previous = start
        if text:
            cleaned.append({'start':start,'end':end,'text':text})
    chunks, i = [], 0
    while i < len(cleaned):
        j = i + 1
        while j < len(cleaned) and cleaned[j]['end'] - cleaned[i]['start'] <= 60 and sum(len(s['text'].split()) for s in cleaned[i:j+1]) <= 220:
            j += 1
        chunks.append((cleaned[i]['start'], cleaned[j-1]['end'], ' '.join(s['text'] for s in cleaned[i:j])))
        i = j - 1 if j - i > 1 and j < len(cleaned) else j
    return chunks

def import_transcript(eid, segments):
    chunks = chunk_segments(segments)
    if not chunks:
        raise ValueError('Transcript has no nonempty segments.')
    with database() as db:
        if not db.execute('SELECT 1 FROM episodes WHERE id=?',(eid,)).fetchone():
            raise ValueError('Unknown episode ID. Sync the feed first.')
        db.execute('DELETE FROM passages WHERE episode_id=?',(eid,))
        db.executemany('INSERT INTO passages(episode_id,start,end,text) VALUES(?,?,?,?)',
                       [(eid,*c) for c in chunks])
        db.execute('UPDATE revision SET value=value+1 WHERE id=1')
    return len(chunks)

def client():
    from openai import OpenAI
    return OpenAI(timeout=15, max_retries=1)

@lru_cache(maxsize=256)
def query_vector(query):
    return np.asarray(client().embeddings.create(model=MODEL, dimensions=DIMENSIONS, input=query).data[0].embedding, dtype=np.float32)

def embed_pending():
    with database() as db:
        rows = db.execute('SELECT id,text FROM passages WHERE embedding IS NULL OR model != ?', (MODEL,)).fetchall()
    for offset in range(0, len(rows), 64):
        batch = rows[offset:offset+64]
        result = client().embeddings.create(model=MODEL, dimensions=DIMENSIONS, input=[r['text'] for r in batch])
        with database() as db:
            for item in result.data:
                row = batch[item.index]
                db.execute('UPDATE passages SET embedding=?, model=? WHERE id=? AND text=?',
                           (json.dumps(item.embedding), MODEL, row['id'], row['text']))
            db.execute('UPDATE revision SET value=value+1 WHERE id=1')
    return len(rows)

@lru_cache(maxsize=2)
def vector_index(path, revision):
    with database() as db:
        rows = db.execute('SELECT id,embedding FROM passages WHERE model=? AND embedding IS NOT NULL',(MODEL,)).fetchall()
    if not rows:
        return [], np.empty((0,DIMENSIONS), dtype=np.float32)
    matrix = np.asarray([json.loads(r['embedding']) for r in rows], dtype=np.float32)
    matrix /= np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-12)
    return [r['id'] for r in rows], matrix

def search(query, mode='smart', limit=20):
    tokens = re.findall(r'\w+', query, flags=re.UNICODE)[:30]
    if not tokens:
        return {'results':[], 'mode':'keyword', 'notice':None}
    with database() as db:
        lexical = db.execute('''SELECT rowid FROM passages_fts WHERE passages_fts MATCH ?
          ORDER BY bm25(passages_fts) LIMIT 100''', (' OR '.join('"'+t+'"' for t in tokens),)).fetchall()
        scores = {r['rowid']:1/(60+rank) for rank,r in enumerate(lexical,1)}
        active, notice = 'keyword', None
        if mode == 'smart':
            rev = db.execute('SELECT value FROM revision WHERE id=1').fetchone()[0]
            ids, matrix = vector_index(os.getenv('SERMON_DB','data/sermons.sqlite3'), rev)
            if ids and os.getenv('OPENAI_API_KEY'):
                try:
                    vector = query_vector(query)
                    similarity = matrix @ (vector / max(float(np.linalg.norm(vector)),1e-12))
                    order = np.argsort(similarity)[::-1][:100]
                    for rank, idx in enumerate(order,1):
                        if similarity[idx] >= .3:
                            pid = ids[idx]
                            scores[pid] = scores.get(pid,0) + 1/(60+rank)
                    active = 'hybrid'
                except Exception:
                    notice = 'Meaning search is temporarily unavailable. Showing keyword matches.'
            else:
                notice = 'Showing keyword matches. Meaning search needs indexed embeddings and a server API key.'
        results = []
        for pid in sorted(scores,key=scores.get, reverse=True):
            row = db.execute('''SELECT p.id,p.episode_id,p.start,p.end,p.text,e.title,e.date,e.audio_url,e.speaker,e.speaker_source
              FROM passages p JOIN episodes e ON e.id=p.episode_id WHERE p.id=?''',(pid,)).fetchone()
            # Avoid adjacent overlapping hits crowding the page.
            if any(r['episode_id']==row['episode_id'] and max(r['start'],row['start'])<min(r['end'],row['end']) for r in results):
                continue
            results.append(dict(row))
            if len(results)>=limit:
                break
    return {'results':results,'mode':active,'notice':notice}

def episodes():
    with database() as db:
        return [dict(r) for r in db.execute('''SELECT e.*,COUNT(p.id) AS passages
          FROM episodes e LEFT JOIN passages p ON p.episode_id=e.id GROUP BY e.id ORDER BY date DESC''')]

def stats():
    with database() as db:
        return {'episodes':db.execute('SELECT count(*) FROM episodes').fetchone()[0],
                'indexed':db.execute('SELECT count(DISTINCT episode_id) FROM passages').fetchone()[0],
                'passages':db.execute('SELECT count(*) FROM passages').fetchone()[0],
                'embedded':db.execute('SELECT count(*) FROM passages WHERE embedding IS NOT NULL AND model=?',(MODEL,)).fetchone()[0]}

import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from sermon_search import core
from sermon_search.cloudflare import export_archive


class ExportTests(unittest.TestCase):
    def test_export_quotes_metadata_and_preserves_remote_transcripts(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'SERMON_DB': str(Path(directory)/'local.db')}):
            core.init()
            with core.database() as db:
                db.execute('INSERT INTO episodes VALUES(?,?,?,?,?,?)',('one',"God's grace",'2026-01-01','https://example.com/audio','Line one\nline two',''))
                db.execute('INSERT INTO episodes VALUES(?,?,?,?,?,?)',('two','Faith','2026-01-02','https://example.com/audio','',''))
            core.import_transcript('one',[{'start':10,'end':20,'text':"God's grace is sufficient"}])
            destination=Path(directory)/'archive.sql'
            result=export_archive(destination)
            self.assertEqual(result['passages'],1)
            remote=sqlite3.connect(':memory:')
            remote.executescript(Path('migrations/0001_schema.sql').read_text())
            remote.execute('INSERT INTO episodes VALUES(?,?,?,?,?,?)',('two','Faith','2026-01-02','https://example.com/audio','',''))
            remote.execute('INSERT INTO passages(id,episode_id,start,end,text) VALUES(99,\'two\',0,5,\'Existing remote transcript\')')
            remote.executescript(destination.read_text())
            remote.executescript(destination.read_text())
            self.assertEqual(remote.execute('SELECT count(*) FROM passages').fetchone()[0],2)
            self.assertEqual(remote.execute('SELECT title FROM episodes WHERE id=\'one\'').fetchone()[0],"God's grace")
            self.assertEqual(remote.execute("SELECT rowid FROM passages_fts WHERE passages_fts MATCH 'grace'").fetchone()[0],1)
            self.assertEqual(destination.with_suffix('.ndjson').read_text(),'')
            remote.close()

if __name__=='__main__': unittest.main()

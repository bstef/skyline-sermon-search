import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from sermon_search import core

FEED = b'''<rss><channel><item><guid>test-one</guid><title>Example sermon</title><pubDate>Sun, 04 Oct 2026 20:09:36 GMT</pubDate><enclosure url="https://example.com/audio.mp3"/><description>Example</description></item></channel></rss>'''

class SearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'SERMON_DB':str(Path(self.temp.name)/'test.sqlite3')})
        self.env.start(); core.init(); core.ingest_xml(FEED)
        self.eid = core.episodes()[0]['id']
    def tearDown(self):
        self.env.stop(); self.temp.cleanup(); core.vector_index.cache_clear()
    def test_sync_is_idempotent_and_preserves_transcript(self):
        core.import_transcript(self.eid,[{'start':10,'end':20,'text':'Forgiveness frees us.'}])
        core.ingest_xml(FEED)
        self.assertEqual(core.stats()['episodes'],1)
        self.assertEqual(core.stats()['passages'],1)
    def test_keyword_returns_correct_timestamp_and_audio(self):
        core.import_transcript(self.eid,[{'start':125,'end':145,'text':'Forgiveness frees us.'}])
        result = core.search('forgiveness','keyword')['results'][0]
        self.assertEqual(result['start'],125)
        self.assertEqual(result['audio_url'],'https://example.com/audio.mp3')
    def test_reimport_removes_old_fts_results(self):
        core.import_transcript(self.eid,[{'start':1,'end':2,'text':'anger'}])
        core.import_transcript(self.eid,[{'start':3,'end':4,'text':'peace'}])
        self.assertEqual(core.search('anger','keyword')['results'],[])
        self.assertEqual(len(core.search('peace','keyword')['results']),1)
    def test_bad_times_do_not_destroy_transcript(self):
        core.import_transcript(self.eid,[{'start':1,'end':2,'text':'peace'}])
        with self.assertRaises(ValueError):
            core.import_transcript(self.eid,[{'start':float('nan'),'end':2,'text':'anger'}])
        self.assertEqual(core.stats()['passages'],1)
    def test_empty_transcript_rejected(self):
        with self.assertRaises(ValueError): core.import_transcript(self.eid,[])
    def test_fts_operator_input_is_safe(self):
        for query in ['" OR NOT *','- ( )','forgiveness NEAR peace',"O'Brien"]:
            self.assertIsInstance(core.search(query,'keyword')['results'],list)
    def test_chunk_overlap_has_correct_offsets(self):
        chunks = core.chunk_segments([{'start':i*20,'end':i*20+20,'text':f'Segment {i}'} for i in range(8)])
        self.assertEqual(chunks[0][:2],(0,60))
        self.assertEqual(chunks[1][:2],(40,100))
    def test_semantic_query_finds_passage_without_keyword_overlap(self):
        core.import_transcript(self.eid,[{'start':10,'end':20,'text':'We can release resentment.'}])
        vec = [1.0]+[0.0]*(core.DIMENSIONS-1)
        with core.database() as db:
            db.execute('UPDATE passages SET embedding=?,model=?',(json.dumps(vec),core.MODEL))
            db.execute('UPDATE revision SET value=value+1 WHERE id=1')
        with patch.dict(os.environ,{'OPENAI_API_KEY':'test-key'}), patch.object(core,'query_vector',return_value=np.asarray(vec)):
            result=core.search('forgiveness')
        self.assertEqual(result['mode'],'hybrid')
        self.assertEqual(len(result['results']),1)
    def test_embedding_failure_falls_back_to_keywords(self):
        core.import_transcript(self.eid,[{'start':1,'end':2,'text':'peace'}])
        with core.database() as db:
            db.execute('UPDATE passages SET embedding=?,model=?',(json.dumps([1.0]+[0.0]*511),core.MODEL))
        with patch.dict(os.environ,{'OPENAI_API_KEY':'test-key'}), patch.object(core,'query_vector',side_effect=RuntimeError()):
            result=core.search('peace')
        self.assertEqual(result['mode'],'keyword')
        self.assertEqual(len(result['results']),1)
        self.assertIn('temporarily',result['notice'])

if __name__=='__main__': unittest.main()

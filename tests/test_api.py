import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from sermon_search.app import app
from sermon_search import core

class ApiTests(unittest.TestCase):
    def test_http_search_and_validation(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{'SERMON_DB':str(Path(temp)/'api.sqlite3')}), TestClient(app) as client:
            with core.database() as db:
                db.execute('INSERT INTO episodes(id,title,date,audio_url,description,link) VALUES(?,?,?,?,?,?)',('test','Example sermon','2026-10-04','https://example.com/sermon.mp3','',''))
            core.import_transcript('test',[{'start':125,'end':155,'text':'We talk about forgiveness and peace.'}])
            result = client.get('/api/search',params={'q':'forgiveness','mode':'keyword'})
            self.assertEqual(result.status_code,200)
            self.assertEqual(result.json()['results'][0]['start'],125)
            self.assertEqual(client.get('/api/stats').json()['indexed'],1)
            self.assertEqual(client.get('/api/search',params={'q':'x'*301}).status_code,422)
            self.assertEqual(client.get('/api/search',params={'q':'peace','mode':'bad'}).status_code,422)
            self.assertEqual(client.get('/').status_code,200)
            self.assertEqual(client.get('/calendar').status_code,200)
            self.assertEqual(client.get('/static/calendar.js').status_code,200)
            self.assertEqual(client.get('/static/player.js').status_code,200)
            self.assertEqual(client.get('/static/app.js').status_code,200)
            self.assertEqual(client.post('/api/sync').status_code,404)

if __name__=='__main__': unittest.main()

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from sermon_search import core, publishing
from sermon_search.transcription import transcription_plan, atomic_json


class PublishingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'SERMON_DB': str(self.root/'db.sqlite3'), 'TRANSCRIPT_CACHE_DIR': str(self.root/'transcripts'), 'GROQ_TRANSCRIPTION_MODEL':'whisper-large-v3-turbo'}, clear=True)
        self.env.start(); core.init()
        with core.database() as db:
            db.execute('INSERT INTO episodes(id,title,date,audio_url,description,link) VALUES(?,?,?,?,?,?)', ('a'*20,'Fixture','2026-10-04','https://example.com/a.mp3','',''))
        self.segments = [{'start':0,'end':10,'text':'Fixture transcript.'}]
        core.import_transcript('a'*20,self.segments)
        path = Path(transcription_plan('a'*20)['cache_directory'])/'transcript.json'
        path.parent.mkdir(parents=True)
        atomic_json(path, {'episode_id':'a'*20,'segments':self.segments})
        self.response = {'status':'published','episode_id':'a'*20,'content_hash':'test'}

    def tearDown(self):
        self.env.stop();self.temp.cleanup()

    def test_success_marks_publication_and_skips_retries(self):
        with patch.object(publishing,'send',return_value=self.response) as send:
            first=publishing.publish_pending('https://example.com/api',dry_run=False)
            second=publishing.publish_pending('https://example.com/api',dry_run=False)
        self.assertEqual(len(first),1);self.assertEqual(second,[]);self.assertEqual(send.call_count,1)

    def test_failure_keeps_saved_transcript_pending_without_transcription(self):
        with patch.object(publishing,'send',side_effect=RuntimeError('outage')):
            with self.assertRaises(RuntimeError):publishing.publish_pending('https://example.com/api',dry_run=False)
        with patch.object(publishing,'send',return_value=self.response) as send:
            publishing.publish_pending('https://example.com/api',dry_run=False)
        self.assertEqual(send.call_count,1)
        self.assertEqual(len(core.search('fixture','keyword')['results']),1)

    def test_validation_does_not_mark_as_published(self):
        with patch.object(publishing,'send',return_value={**self.response,'status':'validated'}) as send:
            publishing.publish_pending('https://example.com/api')
            publishing.publish_pending('https://example.com/api')
        self.assertEqual(send.call_count,2)
        self.assertTrue(send.call_args.args[0]['dry_run'])

    def test_model_change_uses_original_transcript_without_rechunking(self):
        with patch.dict(os.environ,{'GROQ_TRANSCRIPTION_MODEL':'whisper-large-v3'}),patch.object(publishing,'send',return_value=self.response) as send:
            publishing.publish_pending('https://example.com/api',dry_run=False)
        self.assertEqual(send.call_args.args[0]['segments'],self.segments)

    def test_endpoint_change_republishes_to_new_destination(self):
        with patch.object(publishing,'send',return_value=self.response) as send:
            publishing.publish_pending('https://one.example/api',dry_run=False)
            publishing.publish_pending('https://two.example/api',dry_run=False)
        self.assertEqual(send.call_count,2)

    def test_rejects_non_https_and_refuses_credential_redirect(self):
        for endpoint in ['http://example.com/api','https://user:key@example.com/api','https://example.com/api?token=x']:
            with self.assertRaises(ValueError):publishing.send({},endpoint)
        self.assertIsNone(publishing.NoRedirect().redirect_request(None,None,302,'',{},'https://other.example'))

    def test_missing_credentials_does_not_send_a_request(self):
        with patch.dict(os.environ,{'SKYLINE_PUBLISH_TOKEN_FILE':str(self.root/'missing')}),patch.object(publishing,'build_opener') as opener:
            with self.assertRaises(RuntimeError):publishing.send({},'https://example.com/api')
        opener.assert_not_called()


if __name__ == '__main__': unittest.main()

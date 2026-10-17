import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
from openai import OpenAI
from sermon_search import core, transcription as tx


class GroqTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'SERMON_DB':str(Path(self.temp.name)/'db.sqlite3'),
            'TRANSCRIPT_CACHE_DIR':str(Path(self.temp.name)/'transcripts'),
            'GROQ_TRANSCRIPTION_MODEL':'whisper-large-v3','GROQ_API_KEY':'fake-groq-key'}, clear=True)
        self.env.start();core.init()
        with core.database() as db:
            db.execute('INSERT INTO episodes(id,title,date,audio_url,description,link) VALUES(?,?,?,?,?,?)',('episode','Test sermon','2026-10-04','https://example.com/audio.mp3','',''))
    def tearDown(self):
        self.env.stop();self.temp.cleanup()
    def test_explicit_groq_client_is_separate_from_openai(self):
        with patch('openai.OpenAI') as sdk:
            tx.transcription_client()
        self.assertEqual(sdk.call_args.kwargs['api_key'],'fake-groq-key')
        self.assertEqual(sdk.call_args.kwargs['base_url'],tx.GROQ_URL)
        self.assertEqual(sdk.call_args.kwargs['timeout'],120)
    def test_dry_run_never_downloads_or_calls_provider(self):
        with patch.object(tx,'urlopen') as download, patch.object(tx,'transcription_client') as client:
            result=tx.transcription_plan('episode')
        download.assert_not_called();client.assert_not_called()
        self.assertEqual(result['model'],'whisper-large-v3')
        self.assertFalse(result['starts_processing'])
        self.assertNotIn('fake-groq-key',json.dumps(result))
    def test_missing_key_fails_before_download(self):
        with patch.dict(os.environ,{'GROQ_API_KEY':''}),patch.object(tx.shutil,'which',return_value='/fake/tool'),patch.object(tx,'urlopen') as download:
            with self.assertRaisesRegex(RuntimeError,'GROQ_API_KEY'):tx.transcribe('episode')
        download.assert_not_called()
    def test_rejects_unknown_model(self):
        with patch.dict(os.environ,{'GROQ_TRANSCRIPTION_MODEL':'../bad'}):
            with self.assertRaises(ValueError):tx.transcription_plan('episode')
    def test_turbo_has_separate_cache(self):
        large=tx.transcription_plan('episode')['cache_directory']
        with patch.dict(os.environ,{'GROQ_TRANSCRIPTION_MODEL':'whisper-large-v3-turbo'}):
            turbo=tx.transcription_plan('episode')['cache_directory']
        self.assertNotEqual(large,turbo)
    def fake_split(self,args,check):
        directory=Path(args[-1]).parent
        (directory/'part-0000.flac').write_bytes(b'chunk-zero')
        (directory/'part-0001.flac').write_bytes(b'chunk-one')
    def provider(self,fail_second=False):
        client=MagicMock()
        first=SimpleNamespace(model_dump=lambda:{'segments':[{'start':2,'end':12,'text':'Forgiveness matters.'}]})
        second=SimpleNamespace(model_dump=lambda:{'segments':[{'start':3,'end':13,'text':'We trust God.'}]})
        client.audio.transcriptions.create.side_effect=[first,RuntimeError('temporary failure') if fail_second else second]
        return client
    def processing(self,client):
        from contextlib import ExitStack
        stack=ExitStack()
        stack.enter_context(patch.object(tx,'transcription_client',return_value=client))
        stack.enter_context(patch.object(tx.shutil,'which',return_value='/fake/tool'))
        stack.enter_context(patch.object(tx,'urlopen',side_effect=lambda *a,**kw:io.BytesIO(b'fake original audio')))
        stack.enter_context(patch.object(tx.subprocess,'run',side_effect=self.fake_split))
        stack.enter_context(patch.object(tx.subprocess,'check_output',return_value=b'{"frames":[{"nb_samples":9600000}]}'))
        return stack
    def test_offsets_model_parameters_and_cached_resume(self):
        client=self.provider()
        with self.processing(client):
            self.assertEqual(tx.transcribe('episode'),2)
            tx.transcribe('episode')
        self.assertEqual(client.audio.transcriptions.create.call_count,2)
        params=client.audio.transcriptions.create.call_args.kwargs
        self.assertEqual(params['model'],'whisper-large-v3')
        self.assertEqual(params['timestamp_granularities'],['segment'])
        self.assertEqual(params['response_format'],'verbose_json')
        self.assertEqual(core.search('trust','keyword')['results'][0]['start'],603)
    def test_failure_preserves_index_and_resumes_finished_chunks(self):
        core.import_transcript('episode',[{'start':0,'end':10,'text':'Original transcript.'}])
        client=self.provider(fail_second=True)
        with self.processing(client):
            with self.assertRaises(RuntimeError):tx.transcribe('episode')
        self.assertEqual(len(core.search('original','keyword')['results']),1)
        resumed=MagicMock()
        resumed.audio.transcriptions.create.return_value=SimpleNamespace(model_dump=lambda:{'segments':[{'start':3,'end':13,'text':'We trust God.'}]})
        with self.processing(resumed):tx.transcribe('episode')
        self.assertEqual(resumed.audio.transcriptions.create.call_count,1)
        self.assertEqual(core.search('original','keyword')['results'],[])
    def test_chunk_duration_uses_samples_when_flac_header_has_no_duration(self):
        with patch.object(tx.subprocess, 'check_output', return_value=b'{"frames":[{"nb_samples":16000},{"nb_samples":8000}]}') as probe:
            self.assertEqual(tx.chunk_duration(Path('part.flac')), 1.5)
        self.assertIn('-show_frames', probe.call_args.args[0])

    def test_chunk_duration_rejects_missing_samples(self):
        with patch.object(tx.subprocess, 'check_output', return_value=b'{"frames":[]}'):
            with self.assertRaisesRegex(RuntimeError, 'duration'):
                tx.chunk_duration(Path('part.flac'))

    def test_missing_duration_keeps_cross_chunk_search_timestamps(self):
        client = self.provider()
        with self.processing(client), patch.object(tx.subprocess, 'check_output', return_value=b'{"frames":[{"nb_samples":9600000}]}'):
            tx.transcribe('episode')
        self.assertEqual(core.search('trust', 'keyword')['results'][0]['start'], 603)

    def test_budget_defers_before_sending_audio(self):
        from sermon_search.budget import BudgetDeferred
        client=self.provider()
        with self.processing(client), patch.dict(os.environ, {'SKYLINE_AUDIO_BUDGET_DB':str(Path(self.temp.name)/'budget.sqlite3'), 'SKYLINE_AUDIO_BUDGET_SETTINGS':'{"hour_seconds":600}'}):
            with self.assertRaises(BudgetDeferred): tx.transcribe('episode')
        self.assertEqual(client.audio.transcriptions.create.call_count,1)

    def test_invalid_response_is_retained_without_repeating_provider_call(self):
        client=self.provider()
        client.audio.transcriptions.create.side_effect=None
        client.audio.transcriptions.create.return_value=SimpleNamespace(model_dump=lambda:{'segments':[{'start':-1,'end':2,'text':'Bad timestamp'}]})
        with self.processing(client):
            for _ in range(2):
                with self.assertRaises(ValueError):tx.transcribe('episode')
        self.assertEqual(client.audio.transcriptions.create.call_count,1)

    def test_groq_429_starts_persistent_cooldown_and_stops_requests(self):
        from sermon_search.budget import BudgetDeferred
        class Limited(RuntimeError):
            status_code=429
        client=self.provider()
        client.audio.transcriptions.create.side_effect=Limited('provider limited')
        env={'SKYLINE_AUDIO_BUDGET_DB':str(Path(self.temp.name)/'budget.sqlite3'),'SKYLINE_AUDIO_BUDGET_SETTINGS':'{}'}
        with self.processing(client), patch.dict(os.environ,env):
            with self.assertRaisesRegex(BudgetDeferred,'groq_rate_limit'):tx.transcribe('episode')
            with self.assertRaisesRegex(BudgetDeferred,'provider_cooldown'):tx.transcribe('episode')
        self.assertEqual(client.audio.transcriptions.create.call_count,1)

    def test_budget_mode_disables_automatic_sdk_retries(self):
        with patch.dict(os.environ, {'SKYLINE_AUDIO_BUDGET_DB':'budget.sqlite3'}), patch('openai.OpenAI') as sdk:
            tx.transcription_client()
        self.assertEqual(sdk.call_args.kwargs['max_retries'],0)

    def test_actual_sdk_serializes_request_to_groq_with_mock_transport(self):
        def handle(request):
            self.assertEqual(request.url.host,'api.groq.com')
            self.assertEqual(request.headers['authorization'],'Bearer fake-groq-key')
            body=request.read()
            self.assertIn(b'whisper-large-v3',body)
            self.assertIn(b'timestamp_granularities[]',body)
            return httpx.Response(200,json={'text':'A sermon.','language':'english','duration':10,'segments':[{'start':0,'end':10,'text':'A sermon.'}]})
        client=OpenAI(api_key='fake-groq-key',base_url=tx.GROQ_URL,http_client=httpx.Client(transport=httpx.MockTransport(handle)))
        try:
            result=client.audio.transcriptions.create(model='whisper-large-v3',file=('test.flac',b'fake audio'),response_format='verbose_json',timestamp_granularities=['segment'])
            self.assertEqual(tx.valid_segments(result.model_dump())[0]['text'],'A sermon.')
        finally:client.close()

if __name__=='__main__':unittest.main()

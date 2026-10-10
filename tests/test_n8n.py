import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sermon_search import core, n8n


class N8nRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.config = self.directory / 'config.json'
        self.settings = {'data_dir': str(self.directory), 'since': '2020-01-01'}
        self.env = patch.dict(os.environ, {'SERMON_DB': str(self.directory / 'sermons.sqlite3')})
        self.env.start()
        core.init()
        with core.database() as db:
            for eid, day in [('old', '2014-01-01'), ('one', '2021-01-01'), ('two', '2021-01-02'), ('future', '2999-01-01')]:
                db.execute('INSERT INTO episodes(id,title,date,audio_url,description,link) VALUES(?,?,?,?,?,?)',
                           (eid, eid, day, 'https://example.com/audio.mp3', '', ''))

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def run_config(self, **updates):
        self.settings.update(updates)
        self.config.write_text(json.dumps(self.settings))
        with patch.object(core, 'sync', return_value=4):
            return n8n.run(self.config)

    def test_default_preview_never_transcribes_and_limits_batch(self):
        with patch.object(n8n, 'transcribe') as paid:
            report = self.run_config()
        paid.assert_not_called()
        self.assertTrue(report['dry_run'])
        self.assertEqual([p['episode_id'] for p in report['selected']], ['one'])

    def test_completed_episode_is_skipped_on_next_run(self):
        def process(eid):
            return core.import_transcript(eid, [{'start': 0, 'end': 10, 'text': 'Test sermon.'}])
        with patch.object(n8n, 'transcribe', side_effect=process) as paid:
            first = self.run_config(dry_run=False)
            second = self.run_config(dry_run=False)
        self.assertEqual([c['episode_id'] for c in first['completed']], ['one'])
        self.assertEqual([c['episode_id'] for c in second['completed']], ['two'])
        self.assertEqual(paid.call_count, 2)

    def test_archive_requires_explicit_flag_and_excludes_future(self):
        report = self.run_config(include_archive=True, max_episodes=20)
        self.assertEqual([p['episode_id'] for p in report['selected']], ['old', 'one', 'two'])

    def test_failure_leaves_episode_pending_and_reports_failure(self):
        with patch.object(n8n, 'transcribe', side_effect=RuntimeError('fake provider failure')):
            with self.assertRaises(RuntimeError):
                self.run_config(dry_run=False)
        self.assertEqual(json.loads((self.directory / 'last-run.json').read_text())['failed_episode_id'], 'one')
        report = self.run_config(dry_run=True)
        self.assertEqual(report['selected'][0]['episode_id'], 'one')

    def test_first_run_boundary_persists_for_catchup(self):
        self.run_config(since=None)
        original = (self.directory / 'first-run.json').read_text()
        self.run_config()
        self.assertEqual((self.directory / 'first-run.json').read_text(), original)

    def test_malformed_boolean_cannot_start_paid_run(self):
        with patch.object(n8n, 'transcribe') as paid:
            with self.assertRaises(ValueError):
                self.run_config(dry_run='false')
        paid.assert_not_called()

    def test_overlapping_run_does_not_sync_or_transcribe(self):
        import fcntl
        self.config.write_text(json.dumps(self.settings))
        with (self.directory / 'run.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(core, 'sync') as sync, patch.object(n8n, 'transcribe') as paid:
                self.assertEqual(n8n.run(self.config)['status'], 'busy')
            sync.assert_not_called()
            paid.assert_not_called()

    def test_workflow_import_is_inactive_and_schedule_disabled(self):
        path = Path(__file__).parents[1] / 'integrations/n8n/skyline-echo-groq.workflow.json'
        workflow = json.loads(path.read_text())
        self.assertFalse(workflow['active'])
        schedule = next(n for n in workflow['nodes'] if n['type'].endswith('scheduleTrigger'))
        self.assertTrue(schedule['disabled'])

    def test_preview_never_publishes_even_if_publication_is_enabled(self):
        with patch('sermon_search.publishing.publish_pending') as publish:
            self.run_config(publishing={'enabled': True, 'dry_run': False, 'endpoint': 'https://example.com/api'})
        publish.assert_not_called()

    def test_saved_transcripts_publish_when_no_new_sermons_are_selected(self):
        with patch.object(n8n, 'transcribe') as paid, patch('sermon_search.publishing.publish_pending', return_value=[{'status':'published'}]) as publish:
            report = self.run_config(since='2999-01-01', dry_run=False, publishing={'enabled':True,'dry_run':False,'endpoint':'https://example.com/api'})
        paid.assert_not_called()
        publish.assert_called_once_with('https://example.com/api',1,False)
        self.assertEqual(report['publishing'][0]['status'],'published')


if __name__ == '__main__':
    unittest.main()

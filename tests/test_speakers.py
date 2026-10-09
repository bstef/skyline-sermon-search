import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
from sermon_search import core
from sermon_search.speakers import speaker_credit


def item(description='', title='Example', extra=''):
    return ET.fromstring(f'<item><title>{title}</title><description>{description}</description>{extra}</item>')


class SpeakerTests(unittest.TestCase):
    def test_publisher_and_unattributed_names_are_not_speakers(self):
        for description in ['First appeared at Skyline Church.', 'A quote from Pastor Chris about prayer.']:
            self.assertEqual(speaker_credit(item(description,extra='<author>Skyline Church</author>')), ('',''))
        self.assertEqual(speaker_credit(item('Speaker: Skyline Church')), ('',''))

    def test_explicit_credits_and_guest_discussion(self):
        self.assertEqual(speaker_credit(item('&lt;p&gt;Speaker: Jane Doe&lt;/p&gt;')), ('Jane Doe','description'))
        self.assertEqual(speaker_credit(item(title='Faith - by Pastor Chris')), ('Pastor Chris','title'))
        self.assertEqual(speaker_credit(item('Pastor Chris is joined by Janaïs Mia for a special questions and answers discussion.')), ('Pastor Chris & Janaïs Mia','description'))
        self.assertEqual(speaker_credit(item('This message includes input from some of the elders of our church along with Pastor Chris.')), ('Pastor Chris & church elders','description'))

    def test_structured_role_distinguishes_host_from_speaker(self):
        extra='<p:person xmlns:p="https://podcastindex.org/namespace/1.0" role="host">Jane Doe</p:person>'
        self.assertEqual(speaker_credit(item(extra=extra)), ('',''))
        self.assertEqual(speaker_credit(item(extra=extra.replace('host','speaker'))), ('Jane Doe','podcast:person'))

    def test_existing_database_upgrade_and_sync_preserve_transcript(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{'SERMON_DB':str(Path(temp)/'old.db')}):
            db=sqlite3.connect(os.environ['SERMON_DB'])
            db.executescript(Path('migrations/0001_schema.sql').read_text());db.close()
            core.init();core.init()
            feed=b'<rss><channel><item><guid>one</guid><title>Faith</title><pubDate>Sun, 04 Oct 2026 20:09:36 GMT</pubDate><enclosure url="https://example.com/a.mp3"/><description>Speaker: Jane Doe</description></item></channel></rss>'
            core.ingest_xml(feed);eid=core.episodes()[0]['id']
            core.import_transcript(eid,[{'start':10,'end':20,'text':'Grace abounds'}])
            self.assertEqual(core.search('grace','keyword')['results'][0]['speaker'],'Jane Doe')
            core.ingest_xml(feed.replace(b'Speaker: Jane Doe',b'First appeared at Skyline Church.'))
            self.assertEqual(core.episodes()[0]['speaker'],'')
            self.assertEqual(core.stats()['passages'],1)

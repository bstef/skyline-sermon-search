import json
from pathlib import Path
import tempfile
import unittest
from sermon_search.budget import AudioBudget, BudgetDeferred

class AudioBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.path=Path(self.temp.name)/'budget.sqlite3'
        self.clock=[100000.0]
    def tearDown(self): self.temp.cleanup()
    def budget(self, **settings): return AudioBudget(self.path,settings,now=lambda:self.clock[0])
    def test_reservations_survive_restart_and_failed_requests(self):
        b=self.budget(); b.reserve(600.01,'a','turbo','chunk')
        self.assertEqual(self.budget().summary()['day_audio_seconds'],601)
    def test_hour_cap_and_rolling_expiration(self):
        b=self.budget(hour_seconds=600); b.reserve(600,'a','turbo','1')
        with self.assertRaises(BudgetDeferred):b.reserve(10,'a','turbo','2')
        self.clock[0]+=3601; b.reserve(600,'a','turbo','2')
    def test_day_cap_applies_across_hour_windows(self):
        b=self.budget(hour_seconds=600,day_seconds=600); b.reserve(600,'a','turbo','1')
        self.clock[0]+=4000
        with self.assertRaisesRegex(BudgetDeferred,'day_audio_budget'):b.reserve(10,'a','turbo','2')
        self.clock[0]+=86400; b.reserve(600,'a','turbo','2')
    def test_seventh_episode_is_deferred_but_same_episode_can_resume(self):
        b=self.budget()
        for i in range(6):b.reserve(10,str(i),'turbo','1')
        with self.assertRaisesRegex(BudgetDeferred,'six_sermon_budget'):b.reserve(10,'seventh','turbo','1')
        b.reserve(10,'0','turbo','2')
    def test_provider_cooldown_survives_restart(self):
        self.budget().pause(86400)
        with self.assertRaisesRegex(BudgetDeferred,'provider_cooldown'):self.budget().reserve(10,'a','turbo','1')
    def test_no_reservation_is_recorded_when_deferred(self):
        b=self.budget(hour_seconds=600); b.reserve(600,'a','turbo','1')
        with self.assertRaises(BudgetDeferred):b.reserve(10,'b','turbo','2')
        self.assertEqual(b.summary()['sermons_in_rolling_day'],1)
    def test_limits_cannot_exceed_conservative_free_allowance(self):
        for config in ({'hour_seconds':7200},{'day_seconds':28800},{'episodes_per_day':7},{'day_seconds':'21600'}):
            with self.assertRaises(ValueError):self.budget(**config)

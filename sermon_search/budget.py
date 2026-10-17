"""Persistent, conservative rolling audio allowances for unattended Groq jobs."""
import math
from contextlib import contextmanager
import sqlite3
import time
from pathlib import Path


class BudgetDeferred(RuntimeError):
    def __init__(self, reason, retry_at):
        super().__init__(reason)
        self.reason, self.retry_at = reason, retry_at


class AudioBudget:
    def __init__(self, path, settings, now=time.time):
        self.path, self.now = Path(path), now
        self.hour = settings.get('hour_seconds', 5400)
        self.day = settings.get('day_seconds', 21600)
        self.episodes = settings.get('episodes_per_day', 6)
        if any(type(v) is not int for v in (self.hour, self.day, self.episodes)) or not (600 <= self.hour <= 5400 and self.hour <= self.day <= 21600 and 1 <= self.episodes <= 6):
            raise ValueError('Budget must be integers: hour 600..5400, day hour..21600, episodes 1..6.')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS audio_requests (
                requested_at REAL NOT NULL, seconds REAL NOT NULL, episode_id TEXT NOT NULL,
                model TEXT NOT NULL, fingerprint TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS request_time ON audio_requests(requested_at);
                CREATE TABLE IF NOT EXISTS cooldown (id INTEGER PRIMARY KEY, until REAL NOT NULL);
                INSERT OR IGNORE INTO cooldown VALUES(1,0);''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def reserve(self, seconds, episode_id, model, fingerprint):
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError('Invalid audio budget duration.')
        # Round up so fractional audio seconds never undercount provider usage.
        seconds = max(10, math.ceil(seconds))
        now = self.now()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            until = db.execute('SELECT until FROM cooldown WHERE id=1').fetchone()[0]
            if until > now:
                raise BudgetDeferred('provider_cooldown', until)
            for window, limit, label in [(3600,self.hour,'hour_audio_budget'),(86400,self.day,'day_audio_budget')]:
                rows = db.execute('SELECT requested_at,seconds FROM audio_requests WHERE requested_at>? ORDER BY requested_at', (now-window,)).fetchall()
                if sum(r[1] for r in rows) + seconds > limit:
                    raise BudgetDeferred(label, (rows[0][0]+window+1) if rows else now+window)
            ids = db.execute('SELECT DISTINCT episode_id FROM audio_requests WHERE requested_at>?', (now-86400,)).fetchall()
            if episode_id not in {r[0] for r in ids} and len(ids) >= self.episodes:
                oldest = db.execute('SELECT min(requested_at) FROM audio_requests WHERE requested_at>?', (now-86400,)).fetchone()[0]
                raise BudgetDeferred('six_sermon_budget', oldest+86401)
            # A reservation is committed BEFORE the provider call. Failed or
            # uncertain requests still count, including after a process crash.
            db.execute('INSERT INTO audio_requests VALUES(?,?,?,?,?)', (now,seconds,episode_id,model,fingerprint))

    def pause(self, seconds):
        with self.connect() as db:
            db.execute('UPDATE cooldown SET until=max(until,?) WHERE id=1', (self.now()+seconds,))

    def summary(self):
        now = self.now()
        with self.connect() as db:
            hour = db.execute('SELECT coalesce(sum(seconds),0) FROM audio_requests WHERE requested_at>?', (now-3600,)).fetchone()[0]
            day, count = db.execute('SELECT coalesce(sum(seconds),0),count(DISTINCT episode_id) FROM audio_requests WHERE requested_at>?', (now-86400,)).fetchone()
        return {'hour_audio_seconds':hour,'day_audio_seconds':day,'sermons_in_rolling_day':count,'hour_limit':self.hour,'day_limit':self.day,'sermon_limit':self.episodes}

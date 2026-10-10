CREATE TABLE IF NOT EXISTS transcript_publications (
 episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
 content_hash TEXT NOT NULL,
 passages INTEGER NOT NULL,
 published_at TEXT NOT NULL
);

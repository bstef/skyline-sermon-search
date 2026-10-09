CREATE TABLE episodes (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL,
 audio_url TEXT NOT NULL, description TEXT NOT NULL, link TEXT NOT NULL
);
CREATE INDEX episodes_date ON episodes(date DESC);
CREATE TABLE passages (
 id INTEGER PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
 start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL,
 embedding TEXT, model TEXT,
 CHECK(start >= 0 AND end > start)
);
CREATE INDEX passages_episode ON passages(episode_id);
CREATE VIRTUAL TABLE passages_fts USING fts5(text, content='passages', content_rowid='id');
CREATE TRIGGER passage_insert AFTER INSERT ON passages BEGIN
 INSERT INTO passages_fts(rowid,text) VALUES(new.id,new.text); END;
CREATE TRIGGER passage_delete AFTER DELETE ON passages BEGIN
 INSERT INTO passages_fts(passages_fts,rowid,text) VALUES('delete',old.id,old.text); END;
CREATE TRIGGER passage_update AFTER UPDATE OF text ON passages BEGIN
 INSERT INTO passages_fts(passages_fts,rowid,text) VALUES('delete',old.id,old.text);
 INSERT INTO passages_fts(rowid,text) VALUES(new.id,new.text); END;

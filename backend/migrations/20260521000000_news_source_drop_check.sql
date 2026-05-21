-- Drop the source CHECK on news_items so the channel lineup can evolve without
-- needing a migration every time. SQLite doesn't support DROP CONSTRAINT, so we
-- rebuild the table. Existing rows (if any) are preserved.
CREATE TABLE news_items_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  yt_video_id     TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  channel_name    TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  thumbnail_url   TEXT,
  published_at    TEXT NOT NULL,
  duration_sec    INTEGER NOT NULL DEFAULT 0,
  language        TEXT NOT NULL DEFAULT 'en',
  topic           TEXT NOT NULL DEFAULT 'other'
    CHECK (topic IN ('finance', 'politics', 'tech', 'culture', 'other')),
  difficulty      INTEGER NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
  has_captions    INTEGER NOT NULL DEFAULT 0 CHECK (has_captions IN (0, 1)),
  segments_json   TEXT NOT NULL DEFAULT '[]',
  idioms_json     TEXT NOT NULL DEFAULT '[]',
  fetched_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  analyzed_at     TEXT
);

INSERT INTO news_items_new
SELECT id, yt_video_id, source, channel_id, channel_name, title, description,
       thumbnail_url, published_at, duration_sec, language, topic, difficulty,
       has_captions, segments_json, idioms_json, fetched_at, analyzed_at
FROM news_items;

DROP TABLE news_items;
ALTER TABLE news_items_new RENAME TO news_items;

CREATE INDEX idx_news_items_source_published
  ON news_items(source, published_at DESC);
CREATE INDEX idx_news_items_topic_published
  ON news_items(topic, published_at DESC);
CREATE INDEX idx_news_items_published
  ON news_items(published_at DESC);

-- Idiom support: vocab entries can be either a single word or a multi-word phrase.
ALTER TABLE vocab
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'word'
    CHECK (kind IN ('word', 'idiom'));

CREATE INDEX idx_vocab_kind ON vocab(kind);

-- News feed cache: globally shared, not per-user.
-- Items are pulled from curated YouTube news channels (BBC, Bloomberg, Economist, FT).
-- Captions + idioms are pre-fetched so the user can browse without waiting on import.
CREATE TABLE news_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  yt_video_id     TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL CHECK (source IN ('bbc', 'bloomberg', 'economist', 'ft')),
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

CREATE INDEX idx_news_items_source_published
  ON news_items(source, published_at DESC);
CREATE INDEX idx_news_items_topic_published
  ON news_items(topic, published_at DESC);
CREATE INDEX idx_news_items_published
  ON news_items(published_at DESC);

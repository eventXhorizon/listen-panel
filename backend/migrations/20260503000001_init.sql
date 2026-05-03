CREATE TABLE materials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('local','youtube','bilibili')),
  source_ref  TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE vocab (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id   INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  word          TEXT NOT NULL,
  lemma         TEXT NOT NULL,
  phonetic      TEXT,
  pos           TEXT,
  definition_zh TEXT NOT NULL,
  definition_en TEXT,
  example_zh    TEXT,
  context       TEXT NOT NULL DEFAULT '',
  mastery       INTEGER NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 3),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_vocab_material ON vocab(material_id);
CREATE INDEX idx_vocab_created  ON vocab(created_at DESC);

-- Per-user "quick notes": a sentence the user saw somewhere outside the app,
-- captured with an LLM-generated translation + analysis.
--
-- highlights_json: JSON array of { phrase, meaning_zh, usage_note? }
-- grammar_json:    JSON array of { point, explanation_zh }
-- source:          optional URL or freeform "where I saw this"
CREATE TABLE quick_notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  language        TEXT NOT NULL,
  translation_zh  TEXT NOT NULL,
  highlights_json TEXT NOT NULL DEFAULT '[]',
  grammar_json    TEXT NOT NULL DEFAULT '[]',
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_quick_notes_user_created ON quick_notes(user_id, created_at DESC);

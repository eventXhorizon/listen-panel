-- Per-user library of "model essays" — high-quality English writing the
-- user studies to build input before producing their own output.
--
-- An essay can come from three places, distinguished by `source`:
--   'llm'    — LLM-generated on demand from a topic/style brief
--   'web'    — fetched from a URL (PG essays, public-domain speeches,
--              non-paywalled op-eds); the original URL is preserved
--   'manual' — pasted in by the user directly (still gets analyzed)
--
-- The body is the cleaned, paragraph-separated article text (paragraphs
-- separated by blank lines). UI re-paragraphs by splitting on \n\n.
--
-- language_points_json: JSON array of:
--   { phrase, meaning_zh, usage_note }
-- These are the "carry-away" expressions worth memorizing — 5-15 of them.
--
-- structure_notes_json: JSON array of:
--   { paragraph_index, function, summary_zh }
-- function ∈ 'thesis' | 'evidence' | 'counter' | 'transition' | 'conclusion'
--           | 'narrative' | 'analysis' | 'other'
-- (Catch-all so the LLM doesn't break ingestion with unexpected tags.)
CREATE TABLE model_essays (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title                 TEXT NOT NULL,
  author                TEXT,
  language              TEXT NOT NULL DEFAULT 'en',
  source                TEXT NOT NULL CHECK (source IN ('llm', 'web', 'manual')),
  source_url            TEXT,
  -- 'economist' | 'atlantic' | 'paul_graham' | 'speech' | 'narrative' |
  -- 'op_ed' | 'other' — used for the LLM generation prompt style hint
  -- and for filtering in the UI.
  style                 TEXT NOT NULL DEFAULT 'other',
  -- Optional topic/brief that produced this essay (for 'llm') so the user
  -- can see why they generated it.
  topic                 TEXT,

  body                  TEXT NOT NULL,
  word_count            INTEGER NOT NULL DEFAULT 0,
  language_points_json  TEXT NOT NULL DEFAULT '[]',
  structure_notes_json  TEXT NOT NULL DEFAULT '[]',

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_model_essays_user_created
  ON model_essays(user_id, created_at DESC);
CREATE INDEX idx_model_essays_source
  ON model_essays(source);

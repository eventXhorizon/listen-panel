-- Per-user "writing drafts": each LLM-polished or LLM-translated submission
-- from the writing-practice page is stored as one row so the user can flip
-- back through history.
--
-- mode:        'polish' | 'translate'  — what action the detector chose
-- result_json: full PolishResult JSON, see routes/writing.rs::PolishResult
--              (tips array + rewrite, or translation, plus provider tag)
--
-- Inputs that the local detector rejects ("skip" — empty / code-only /
-- too-short) are NOT stored: they never hit the LLM and there's nothing
-- worth keeping.
CREATE TABLE writing_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original    TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('polish', 'translate')),
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_writing_drafts_user_created
  ON writing_drafts(user_id, created_at DESC);

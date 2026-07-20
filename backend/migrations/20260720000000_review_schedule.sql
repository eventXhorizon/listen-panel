-- Spaced-repetition schedule over the things worth re-seeing: vocab entries
-- (words and idioms alike) and the articles they came from.
--
-- One table for both because the review queue interleaves them and a single
-- due-date index answers "what is due today" in one scan. `kind` says which
-- of vocab_id / material_id is set; the CHECK keeps the other NULL.
--
-- step indexes the fixed Ebbinghaus ladder (1, 2, 4, 7, 15, 30, 60 days) held
-- in the backend. Recalling correctly advances one rung; failing drops back to
-- the first. The ladder lives in code, not here, so its shape can change
-- without a migration -- step is just a rung number.
--
-- due_on is a plain 'YYYY-MM-DD' in the *user's* local day, supplied by the
-- client. The server runs UTC in Docker, so deriving "today" here would roll
-- the day over at 09:00 for a JST user and quietly hand them tomorrow's queue
-- mid-morning.
CREATE TABLE review_schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('vocab', 'material')),
  vocab_id    INTEGER REFERENCES vocab(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id) ON DELETE CASCADE,
  step        INTEGER NOT NULL DEFAULT 0,
  due_on      TEXT    NOT NULL,
  last_review TEXT,
  reviews     INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (kind = 'vocab'    AND vocab_id    IS NOT NULL AND material_id IS NULL) OR
    (kind = 'material' AND material_id IS NOT NULL AND vocab_id    IS NULL)
  )
);

-- Enrolment is idempotent: the queue endpoint re-syncs on every fetch, so the
-- same vocab entry must never gain a second schedule row.
CREATE UNIQUE INDEX idx_review_vocab ON review_schedule(user_id, vocab_id)
  WHERE vocab_id IS NOT NULL;
CREATE UNIQUE INDEX idx_review_material ON review_schedule(user_id, material_id)
  WHERE material_id IS NOT NULL;

-- The one hot query: everything due on or before today, oldest first.
CREATE INDEX idx_review_due ON review_schedule(user_id, due_on);

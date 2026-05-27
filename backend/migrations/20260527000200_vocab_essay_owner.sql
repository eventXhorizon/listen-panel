-- Open up `vocab` so words can also be attached to model_essays, not just
-- to materials. Previously vocab.material_id was NOT NULL and the JOIN to
-- materials was the only way to prove ownership. After this:
--
--   - vocab.user_id is the source of truth for ownership (NOT NULL)
--   - vocab.material_id is now nullable; rows from the bookshelf still
--     populate it
--   - vocab.essay_id is new; rows added from the essay reader populate it
--   - exactly one of material_id / essay_id should be set, but we use a
--     CHECK that at least one is non-null so we always have a context anchor
--
-- SQLite doesn't support dropping NOT NULL in place — rebuild the table.
PRAGMA foreign_keys=OFF;

CREATE TABLE vocab_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id   INTEGER REFERENCES materials(id) ON DELETE CASCADE,
  essay_id      INTEGER REFERENCES model_essays(id) ON DELETE CASCADE,
  word          TEXT NOT NULL,
  language      TEXT NOT NULL DEFAULT 'en',
  kind          TEXT NOT NULL DEFAULT 'word' CHECK (kind IN ('word', 'idiom')),
  lemma         TEXT NOT NULL,
  phonetic      TEXT,
  pos           TEXT,
  definition_zh TEXT NOT NULL,
  definition_en TEXT,
  example_zh    TEXT,
  context       TEXT NOT NULL DEFAULT '',
  mastery       INTEGER NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 3),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (material_id IS NOT NULL OR essay_id IS NOT NULL)
);

INSERT INTO vocab_new
  (id, user_id, material_id, essay_id, word, language, kind, lemma, phonetic, pos,
   definition_zh, definition_en, example_zh, context, mastery, created_at)
SELECT v.id,
       m.user_id,
       v.material_id,
       NULL,
       v.word,
       v.language,
       v.kind,
       v.lemma,
       v.phonetic,
       v.pos,
       v.definition_zh,
       v.definition_en,
       v.example_zh,
       v.context,
       v.mastery,
       v.created_at
FROM vocab v
JOIN materials m ON m.id = v.material_id;

DROP TABLE vocab;
ALTER TABLE vocab_new RENAME TO vocab;

CREATE INDEX idx_vocab_user_created ON vocab(user_id, created_at DESC);
CREATE INDEX idx_vocab_material ON vocab(material_id);
CREATE INDEX idx_vocab_essay ON vocab(essay_id);
CREATE INDEX idx_vocab_kind ON vocab(kind);
CREATE INDEX idx_vocab_language ON vocab(language, created_at DESC);

PRAGMA foreign_keys=ON;

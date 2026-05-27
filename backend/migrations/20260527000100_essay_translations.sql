-- Per-paragraph Chinese translation, aligned to model_essays.body.
--
-- JSON array of strings, one per paragraph (paragraphs are the body
-- split on blank lines). Empty array = no translation yet; the detail
-- page lazily triggers /api/essays/:id/translate the first time it's
-- viewed for an essay that needs one.
--
-- Stored as a parallel array instead of embedding in the body itself
-- so the original English text stays untouched and the UI can toggle
-- the Chinese view on/off cleanly.
ALTER TABLE model_essays
  ADD COLUMN translation_zh_json TEXT NOT NULL DEFAULT '[]';

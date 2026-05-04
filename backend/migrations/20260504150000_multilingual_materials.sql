ALTER TABLE materials
  ADD COLUMN language TEXT NOT NULL DEFAULT 'en';

ALTER TABLE vocab
  ADD COLUMN language TEXT NOT NULL DEFAULT 'en';

UPDATE materials
  SET language = 'en'
  WHERE language IS NULL OR trim(language) = '';

UPDATE vocab
  SET language = 'en'
  WHERE language IS NULL OR trim(language) = '';

CREATE INDEX idx_materials_user_language_updated
  ON materials(user_id, language, updated_at DESC);

CREATE INDEX idx_vocab_language_created
  ON vocab(language, created_at DESC);

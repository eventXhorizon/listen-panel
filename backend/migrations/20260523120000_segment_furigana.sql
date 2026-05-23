-- Furigana ruby HTML for Japanese transcript segments.
-- NULL until the post-import furigana task fills it; the frontend falls back to
-- the plain `text` column when this is NULL or when the user toggles furigana off.
ALTER TABLE transcript_segments ADD COLUMN text_with_furigana TEXT;

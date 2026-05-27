-- Speeches benefit massively from being heard, not just read — adding a
-- YouTube link lets the user listen to delivery, pacing and emphasis
-- alongside the text. Curated classics (Jobs, MLK, JFK, Rowling) ship
-- with the link pre-filled; users can also attach one when pasting their
-- own speech text in.
ALTER TABLE model_essays ADD COLUMN video_url TEXT;

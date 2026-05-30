-- Dedicated pause signal for segment-study generation. Previously the pause
-- request was smuggled through the user-facing `study_stage` text ('暂停中'),
-- which coupled control flow to a magic string across three queries. A real
-- boolean column keeps `study_stage` purely for display.
ALTER TABLE transcription_jobs
  ADD COLUMN study_pause_requested INTEGER NOT NULL DEFAULT 0;

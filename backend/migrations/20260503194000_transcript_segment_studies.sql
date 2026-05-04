ALTER TABLE transcription_jobs
  ADD COLUMN study_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (study_status IN ('pending', 'running', 'succeeded', 'failed', 'skipped'));

ALTER TABLE transcription_jobs
  ADD COLUMN study_error TEXT;

UPDATE transcription_jobs
  SET study_status = 'skipped'
  WHERE status IN ('succeeded', 'failed');

CREATE TABLE transcript_segment_studies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id     INTEGER NOT NULL UNIQUE REFERENCES transcript_segments(id) ON DELETE CASCADE,
  job_id         INTEGER NOT NULL REFERENCES transcription_jobs(id) ON DELETE CASCADE,
  material_id    INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  translation_zh TEXT NOT NULL DEFAULT '',
  grammar_points TEXT NOT NULL DEFAULT '[]',
  usage_points   TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_transcript_segment_studies_job
  ON transcript_segment_studies(job_id);
CREATE INDEX idx_transcript_segment_studies_material
  ON transcript_segment_studies(material_id);

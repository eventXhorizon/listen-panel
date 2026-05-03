CREATE TABLE transcription_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id       INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  language          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  progress          INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error             TEXT,
  media_token_hash  TEXT UNIQUE,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at      TEXT
);

CREATE TABLE transcript_segments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES transcription_jobs(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  text        TEXT NOT NULL
);

CREATE INDEX idx_transcription_jobs_material_created
  ON transcription_jobs(material_id, created_at DESC);
CREATE INDEX idx_transcription_jobs_user_created
  ON transcription_jobs(user_id, created_at DESC);
CREATE INDEX idx_transcript_segments_material_start
  ON transcript_segments(material_id, start_ms);
CREATE INDEX idx_transcript_segments_job_start
  ON transcript_segments(job_id, start_ms);

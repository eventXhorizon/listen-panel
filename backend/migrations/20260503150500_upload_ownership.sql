CREATE TABLE uploads (
  file       TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO uploads (file, user_id)
SELECT source_ref, user_id
FROM materials
WHERE source_type = 'local'
  AND source_ref <> ''
  AND user_id IS NOT NULL;

CREATE INDEX idx_uploads_user_id ON uploads(user_id);

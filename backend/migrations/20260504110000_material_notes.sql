CREATE TABLE material_notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id     INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  target_type     TEXT NOT NULL CHECK (target_type IN ('paragraph', 'segment')),
  target_id       INTEGER,
  paragraph_index INTEGER,
  anchor_text     TEXT NOT NULL DEFAULT '',
  anchor_hash     TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_material_notes_user_material
  ON material_notes(user_id, material_id);

CREATE UNIQUE INDEX idx_material_notes_segment_unique
  ON material_notes(user_id, material_id, target_type, target_id)
  WHERE target_type = 'segment' AND target_id IS NOT NULL;

CREATE UNIQUE INDEX idx_material_notes_paragraph_unique
  ON material_notes(user_id, material_id, target_type, paragraph_index)
  WHERE target_type = 'paragraph' AND paragraph_index IS NOT NULL;

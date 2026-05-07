ALTER TABLE materials
  ADD COLUMN text_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (text_source IN ('manual', 'manual_subtitle', 'auto_subtitle', 'asr'));

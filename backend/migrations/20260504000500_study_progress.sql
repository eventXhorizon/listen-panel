ALTER TABLE transcription_jobs
  ADD COLUMN study_progress INTEGER NOT NULL DEFAULT 0 CHECK (study_progress BETWEEN 0 AND 100);

ALTER TABLE transcription_jobs
  ADD COLUMN study_stage TEXT NOT NULL DEFAULT '';

UPDATE transcription_jobs
  SET study_progress = CASE
      WHEN study_status = 'succeeded' THEN 100
      WHEN study_status IN ('failed', 'skipped') THEN 100
      ELSE 0
    END,
    study_stage = CASE
      WHEN study_status = 'succeeded' THEN '分析完成'
      WHEN study_status = 'failed' THEN '分析失败'
      WHEN study_status = 'skipped' THEN '已跳过'
      ELSE ''
    END;

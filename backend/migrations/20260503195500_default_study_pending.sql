UPDATE transcription_jobs
  SET study_status = 'pending', study_error = NULL
  WHERE study_status = 'skipped'
    AND study_error IS NULL;

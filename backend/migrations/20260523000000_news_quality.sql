-- Quality scoring + view count for news items.
-- Items without a quality assessment (legacy rows) keep quality = NULL and are
-- still shown by the list endpoint until backfill runs. After backfill, the
-- filter `quality >= 7 OR quality IS NULL` only lets NULL-or-passing items
-- through (`/api/news/_backfill_quality` populates the column).
ALTER TABLE news_items ADD COLUMN quality INTEGER;
ALTER TABLE news_items ADD COLUMN quality_reason TEXT;
ALTER TABLE news_items ADD COLUMN view_count INTEGER;

CREATE INDEX idx_news_items_quality_published
  ON news_items(quality, published_at DESC);

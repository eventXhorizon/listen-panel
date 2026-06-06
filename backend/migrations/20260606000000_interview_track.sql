-- Interview catalog: introduce a `track` column for top-level directory
-- grouping (Rust / DDIA / AI Agent), and relax `category` so it can hold
-- additional sub-groups without a future migration every time a new track
-- is added.
--
-- SQLite can't ALTER a CHECK constraint, so we recreate the table. Foreign
-- keys from `interview_questions(topic_id)` reference `interview_topics(id)`
-- by *name*; preserving the IDs in the new table keeps every existing
-- question pointing at the right topic. `defer_foreign_keys` postpones FK
-- validation to COMMIT, which works inside the migration's transaction.
--
-- Backfill rule:
--   * categories starting with `rust_`     → track 'rust'
--   * categories starting with `ddia_`     → track 'ddia'
--   * exact `ai_agent` (or `ai_agent_*`)   → track 'ai_agent'
-- Current data is all `rust_*`; the other branches are forward-compat for
-- the rest of this migration's INSERTs and anything seeded later.

PRAGMA defer_foreign_keys = 1;

CREATE TABLE interview_topics_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  track       TEXT NOT NULL
    CHECK (track IN ('rust', 'ddia', 'ai_agent')),
  category    TEXT NOT NULL,
  chapter_no  INTEGER,
  title_en    TEXT NOT NULL,
  title_zh    TEXT NOT NULL,
  source_url  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO interview_topics_new
  (id, slug, track, category, chapter_no, title_en, title_zh, source_url, sort_order, created_at)
SELECT
  id,
  slug,
  CASE
    WHEN category LIKE 'rust\_%' ESCAPE '\' THEN 'rust'
    WHEN category LIKE 'ddia\_%' ESCAPE '\' THEN 'ddia'
    WHEN category = 'ai_agent' OR category LIKE 'ai\_agent\_%' ESCAPE '\' THEN 'ai_agent'
    ELSE 'rust'
  END AS track,
  category,
  chapter_no,
  title_en,
  title_zh,
  source_url,
  sort_order,
  created_at
FROM interview_topics;

DROP TABLE interview_topics;
ALTER TABLE interview_topics_new RENAME TO interview_topics;

CREATE INDEX idx_interview_topics_track_sort
  ON interview_topics(track, sort_order);
CREATE INDEX idx_interview_topics_category_sort
  ON interview_topics(category, sort_order);

-- ===== DDIA topics =====
--
-- 12 book chapters + 4 system-design supplementary groups. sort_order keeps
-- Rust (10-200) first, DDIA chapters next (1000-1200), then system-design
-- extras (1300-1600). Slug stays kebab-case ASCII so it's safe in JSON keys
-- and URLs.

INSERT INTO interview_topics (slug, track, category, chapter_no, title_en, title_zh, source_url, sort_order) VALUES
  -- Part I: Foundations of data systems
  ('ddia-rsm',           'ddia', 'ddia_foundations',  1, 'Reliable, Scalable, and Maintainable Applications', '可靠 / 可扩展 / 可维护',                  'https://ddia.vonng.com/#/ch1', 1010),
  ('ddia-data-models',   'ddia', 'ddia_foundations',  2, 'Data Models and Query Languages',                   '数据模型 / 查询语言: 关系 / 文档 / 图',  'https://ddia.vonng.com/#/ch2', 1020),
  ('ddia-storage',       'ddia', 'ddia_foundations',  3, 'Storage and Retrieval',                             '存储与检索: B-tree / LSM-tree / OLAP',    'https://ddia.vonng.com/#/ch3', 1030),
  ('ddia-encoding',      'ddia', 'ddia_foundations',  4, 'Encoding and Evolution',                            '编码与演化: schema / protobuf / avro',    'https://ddia.vonng.com/#/ch4', 1040),
  -- Part II: Distributed data
  ('ddia-replication',   'ddia', 'ddia_distributed',  5, 'Replication',                                       '复制: 主从 / 多主 / 无主 / 复制滞后',     'https://ddia.vonng.com/#/ch5', 1050),
  ('ddia-partitioning',  'ddia', 'ddia_distributed',  6, 'Partitioning',                                      '分区: 范围 / 哈希 / 热点 / 再平衡',       'https://ddia.vonng.com/#/ch6', 1060),
  ('ddia-transactions',  'ddia', 'ddia_distributed',  7, 'Transactions',                                      '事务: ACID / 隔离级别 / SSI',             'https://ddia.vonng.com/#/ch7', 1070),
  ('ddia-troubles',      'ddia', 'ddia_distributed',  8, 'The Trouble with Distributed Systems',              '分布式系统的麻烦: 时钟 / 部分失败',       'https://ddia.vonng.com/#/ch8', 1080),
  ('ddia-consistency',   'ddia', 'ddia_distributed',  9, 'Consistency and Consensus',                         '一致性与共识: linearizability / Raft',    'https://ddia.vonng.com/#/ch9', 1090),
  -- Part III: Derived data
  ('ddia-batch',         'ddia', 'ddia_derived',     10, 'Batch Processing',                                  '批处理: MapReduce / 数据流 / join',       'https://ddia.vonng.com/#/ch10', 1100),
  ('ddia-stream',        'ddia', 'ddia_derived',     11, 'Stream Processing',                                 '流处理: 事件溯源 / CDC / 恰好一次',       'https://ddia.vonng.com/#/ch11', 1110),
  ('ddia-future',        'ddia', 'ddia_derived',     12, 'The Future of Data Systems',                        '数据系统的未来: 集成 / 端到端 / 正确性',  'https://ddia.vonng.com/#/ch12', 1120),
  -- System-design supplements (not tied to a chapter)
  ('sysd-consensus',         'ddia', 'ddia_practical', NULL, 'Consensus and Consistency Deep Dive', '共识与一致性深潜: Paxos / Raft / 模型',            NULL, 1300),
  ('sysd-storage-engines',   'ddia', 'ddia_practical', NULL, 'Storage Engines Compared',           '存储引擎对比: LSM / B-tree / 列存 / OLTP vs OLAP', NULL, 1310),
  ('sysd-classic',           'ddia', 'ddia_practical', NULL, 'Classic System Design',              '经典系统设计: URL 短链 / Feed / Chat / Rate Limit', NULL, 1320),
  ('sysd-debug',             'ddia', 'ddia_practical', NULL, 'Production Incidents and Debugging', '生产事故与调试: 脑裂 / 热点 / 时钟 / 滞后',         NULL, 1330);

-- Workplace English track: practical day-to-day office conversations
-- (introductions, opinions, feedback, hard conversations). Sample answers
-- are full scripts the user can rehearse, mixing single "ideal response"
-- and multi-role dialogue formats depending on the scenario.
--
-- SQLite can't ALTER a CHECK constraint, so we recreate `interview_topics`
-- with the wider `track` enum and copy the rows over with FK validation
-- deferred to COMMIT.

PRAGMA defer_foreign_keys = 1;

CREATE TABLE interview_topics_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  track       TEXT NOT NULL
    CHECK (track IN ('rust', 'ddia', 'ai_agent', 'workplace')),
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
SELECT id, slug, track, category, chapter_no, title_en, title_zh, source_url, sort_order, created_at
FROM interview_topics;

DROP TABLE interview_topics;
ALTER TABLE interview_topics_new RENAME TO interview_topics;

CREATE INDEX idx_interview_topics_track_sort
  ON interview_topics(track, sort_order);
CREATE INDEX idx_interview_topics_category_sort
  ON interview_topics(category, sort_order);

-- ===== Workplace topics =====
--
-- Four sub-categories, four topics each. sort_order starts at 2000 so the
-- workplace track sits cleanly after Rust (10-200) and DDIA (1000-1330).

INSERT INTO interview_topics (slug, track, category, chapter_no, title_en, title_zh, source_url, sort_order) VALUES
  -- Introductions / social
  ('wp-intro-newhire',        'workplace', 'workplace_intro',    NULL, 'First-Day Introductions',                  '入职第一天的自我介绍',                  NULL, 2010),
  ('wp-intro-1on1-first',     'workplace', 'workplace_intro',    NULL, 'First 1:1 with a New Manager / Colleague', '和新经理 / 新同事的第一次 1:1',         NULL, 2020),
  ('wp-intro-cross-team',     'workplace', 'workplace_intro',    NULL, 'Cross-Team Introductions',                 '跨团队 / 跨部门介绍',                   NULL, 2030),
  ('wp-intro-networking',     'workplace', 'workplace_intro',    NULL, 'Networking / Remote-Team Hellos',          'Networking / 远程团队首次 hello',       NULL, 2040),
  -- Communication and collaboration
  ('wp-comm-standup',         'workplace', 'workplace_comm',     NULL, 'Standup and Async Status Updates',         '站会和异步进度同步',                    NULL, 2110),
  ('wp-comm-opinion',         'workplace', 'workplace_comm',     NULL, 'Expressing Opinions',                      '表达观点 (同意 / 反对 / 建议)',         NULL, 2120),
  ('wp-comm-clarify',         'workplace', 'workplace_comm',     NULL, 'Asking Questions and Clarifying',          '提问与澄清',                            NULL, 2130),
  ('wp-comm-pushback',        'workplace', 'workplace_comm',     NULL, 'Pushing Back and Setting Boundaries',      '推回不合理要求 / 设边界',               NULL, 2140),
  -- Feedback and 1:1s
  ('wp-fb-give',              'workplace', 'workplace_feedback', NULL, 'Giving Constructive Feedback',             '给建设性反馈 (含 code review)',          NULL, 2210),
  ('wp-fb-receive',           'workplace', 'workplace_feedback', NULL, 'Receiving Feedback',                       '接收反馈 (含负面反馈)',                  NULL, 2220),
  ('wp-fb-ask',               'workplace', 'workplace_feedback', NULL, 'Proactively Asking for Feedback',          '主动求反馈 / 1:1 提成长议题',            NULL, 2230),
  ('wp-fb-career',            'workplace', 'workplace_feedback', NULL, 'Promotion and Career Conversations',       '升职 / 加薪 / 职业谈话',                 NULL, 2240),
  -- Hard scenarios / cross-cultural
  ('wp-hard-decline',         'workplace', 'workplace_hard',     NULL, 'Declining Work and Resetting Expectations','拒绝任务 / 重设期望',                    NULL, 2310),
  ('wp-hard-escalate',        'workplace', 'workplace_hard',     NULL, 'Escalating Issues and Delivering Bad News','升级问题 / 通报坏消息',                  NULL, 2320),
  ('wp-hard-apologize',       'workplace', 'workplace_hard',     NULL, 'Apologizing and Owning Mistakes',          '道歉 / 承认错误',                        NULL, 2330),
  ('wp-hard-presentation',    'workplace', 'workplace_hard',     NULL, 'Presentations and Q&A Survival',           '演讲 / Demo Q&A 兜底',                   NULL, 2340);

PRAGMA defer_foreign_keys = 0;

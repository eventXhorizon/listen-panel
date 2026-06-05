-- Interview practice: English-language technical interview prep, anchored to
-- the Rust Book chapter outline.
--
-- `interview_topics` is a static catalog (seeded here). Rows are immutable
-- references to a chapter / focus area; the title columns are bilingual so
-- the UI can show the Rust Book heading and a quick Chinese hint side-by-side.
--
-- `interview_questions.user_id` is NULLABLE on purpose:
--   - NULL  → system-curated Q&A shipped with the app (visible to every user,
--             not deletable from the UI)
--   - NOT NULL → user generated this one via LLM and owns it
--
-- The Rust topics are filled in now (chapters 1–20). `ai_agent` topics
-- (LLM tool use, RAG, multi-agent, evals, agent frameworks) get added later
-- in a follow-up migration so the schema is ready but the seed is incremental.

CREATE TABLE interview_topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL
    CHECK (category IN ('rust_basic', 'rust_advanced', 'ai_agent')),
  chapter_no  INTEGER,
  title_en    TEXT NOT NULL,
  title_zh    TEXT NOT NULL,
  source_url  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_interview_topics_category_sort
  ON interview_topics(category, sort_order);

CREATE TABLE interview_questions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  topic_id         INTEGER NOT NULL REFERENCES interview_topics(id) ON DELETE CASCADE,
  question_en      TEXT NOT NULL,
  question_zh      TEXT NOT NULL DEFAULT '',
  sample_answer_en TEXT NOT NULL,
  sample_answer_zh TEXT NOT NULL DEFAULT '',
  key_points_json  TEXT NOT NULL DEFAULT '[]',
  follow_ups_json  TEXT NOT NULL DEFAULT '[]',
  difficulty       TEXT NOT NULL DEFAULT 'senior'
    CHECK (difficulty IN ('mid', 'senior', 'staff')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_interview_questions_user_topic
  ON interview_questions(user_id, topic_id);
CREATE INDEX idx_interview_questions_topic_created
  ON interview_questions(topic_id, created_at DESC);

-- Seed the 20 Rust Book chapter topics. sort_order = chapter_no * 10 so we
-- can splice future supplementary topics between chapters without renumbering.
INSERT INTO interview_topics (slug, category, chapter_no, title_en, title_zh, source_url, sort_order) VALUES
  ('rust-getting-started',  'rust_basic',     1, 'Getting Started',                     '起步: cargo / rustup',                       'https://doc.rust-lang.org/book/ch01-00-getting-started.html',     10),
  ('rust-guessing-game',    'rust_basic',     2, 'Programming a Guessing Game',         '猜数字游戏: 入门综合',                       'https://doc.rust-lang.org/book/ch02-00-guessing-game-tutorial.html', 20),
  ('rust-common-concepts',  'rust_basic',     3, 'Common Programming Concepts',         '变量 / 类型 / 控制流',                       'https://doc.rust-lang.org/book/ch03-00-common-programming-concepts.html', 30),
  ('rust-ownership',        'rust_basic',     4, 'Ownership, References, and Slices',   '所有权 / 借用 / 切片',                       'https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html', 40),
  ('rust-structs',          'rust_basic',     5, 'Structs',                             '结构体',                                     'https://doc.rust-lang.org/book/ch05-00-structs.html',             50),
  ('rust-enums-pattern',    'rust_basic',     6, 'Enums and Pattern Matching',          '枚举 / 模式匹配 / Option',                   'https://doc.rust-lang.org/book/ch06-00-enums.html',               60),
  ('rust-modules',          'rust_basic',     7, 'Packages, Crates, Modules',           '包 / crate / 模块系统',                      'https://doc.rust-lang.org/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html', 70),
  ('rust-collections',      'rust_basic',     8, 'Common Collections',                  'Vec / String / HashMap',                     'https://doc.rust-lang.org/book/ch08-00-common-collections.html',  80),
  ('rust-error-handling',   'rust_basic',     9, 'Error Handling',                      '错误处理: Result / panic / ?',               'https://doc.rust-lang.org/book/ch09-00-error-handling.html',      90),
  ('rust-generics-traits',  'rust_basic',    10, 'Generic Types, Traits, and Lifetimes','泛型 / trait / 生命周期',                    'https://doc.rust-lang.org/book/ch10-00-generics.html',           100),
  ('rust-testing',          'rust_advanced', 11, 'Writing Automated Tests',             '测试: 单元 / 集成 / #[cfg(test)]',           'https://doc.rust-lang.org/book/ch11-00-testing.html',            110),
  ('rust-io-project',       'rust_advanced', 12, 'I/O Project: minigrep',               'I/O 项目: minigrep 综合实战',                'https://doc.rust-lang.org/book/ch12-00-an-io-project.html',      120),
  ('rust-closures-iter',    'rust_advanced', 13, 'Functional Features: Closures, Iterators', '闭包 / 迭代器 / 函数式',                  'https://doc.rust-lang.org/book/ch13-00-functional-features.html',130),
  ('rust-cargo',            'rust_advanced', 14, 'More about Cargo and Crates.io',      'Cargo 高级用法 / 发布',                      'https://doc.rust-lang.org/book/ch14-00-more-about-cargo.html',   140),
  ('rust-smart-pointers',   'rust_advanced', 15, 'Smart Pointers',                      '智能指针: Box / Rc / RefCell / Drop',        'https://doc.rust-lang.org/book/ch15-00-smart-pointers.html',     150),
  ('rust-concurrency',      'rust_advanced', 16, 'Fearless Concurrency',                '并发: thread / channel / Send+Sync / Mutex', 'https://doc.rust-lang.org/book/ch16-00-concurrency.html',        160),
  ('rust-async',            'rust_advanced', 17, 'Async, Futures, and Streams',         '异步: async/await / Future / Stream / tokio','https://doc.rust-lang.org/book/ch17-00-async-await.html',        170),
  ('rust-oop',              'rust_advanced', 18, 'OOP Features',                        '面向对象: trait object / dyn / 动态分发',    'https://doc.rust-lang.org/book/ch18-00-oop.html',                180),
  ('rust-patterns',          'rust_advanced',19, 'Patterns and Matching',               '模式匹配深入: 不可反驳 / 守卫 / 绑定',       'https://doc.rust-lang.org/book/ch19-00-patterns.html',           190),
  ('rust-advanced-features','rust_advanced', 20, 'Advanced Features: unsafe, macros, etc.', 'unsafe / 高级 trait / 宏 / FFI',         'https://doc.rust-lang.org/book/ch20-00-advanced-features.html',  200);

# 维护者手册

每个功能涉及哪些文件、改动时该改哪里、踩过哪些坑。比 README 紧凑,**目标是"看完知道下次改这个功能要 grep 什么"**。

> 跟 README 重叠时,README 是权威;这里只补"改起来怎么改"。

---

## 1. Touchpoint 总览

每个功能横切改一刀涉及的文件清单。

### 1.1 数据模型 / 加列加表
1. `backend/migrations/<timestamp>_<desc>.sql` — 新迁移文件(sqlx 启动自动跑)
2. `backend/src/models.rs` — DTO struct + `FromRow`
3. `backend/src/routes/*.rs` — 用到这列的 handler 加 select / insert
4. `frontend/src/types.ts` — 前端 type
5. `frontend/src/api.ts` — 签名通常稳定,不需要改

时间戳列默认 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`,跟 sqlx-chrono 解析格式兼容。

### 1.2 加路由
1. `backend/src/routes/<module>.rs` — 写 handler + `Router::new().route(...)`
2. `backend/src/routes/mod.rs` — `pub mod <module>;` + `.merge(<module>::router())`
3. `frontend/src/api.ts` — 加 wrapper function
4. (可选)`frontend/src/types.ts` — 请求 / 返回 type

全局 `/api` 前缀挂在 `backend/src/main.rs` 的 `.nest("/api", routes::api_router(state))`。`/health` 是例外,挂在 router root,不带前缀。

### 1.3 加新视频源类型
1. `backend/migrations/...` — 改 `materials.source_type` CHECK 约束
2. `frontend/src/types.ts` — `SourceType` union 加项
3. `frontend/src/components/VideoPlayer.tsx` — 加 case
4. `frontend/src/pages/Editor.tsx` — 添加 TYPES 数组项 + metadata 接口对应支持
5. `asr-worker/worker.py` — 如果 worker 也要支持下载,加对应 yt-dlp 参数

### 1.4 加新学习语言
- 参考 `docs/multilingual-language-adapters.md`。核心是 `backend/src/language.rs::Language` enum 加 variant + 实现 5 个 prompt:lookup / study / quick_note / (news 抓取若有则加)。前端 `Language` union 同步加。

---

## 2. 功能 → 涉及文件

### 2.1 Auth(账户 / session)
- `backend/migrations/20260503142327_auth.sql`(users + sessions)
- `backend/src/routes/auth.rs`(setup / register / login / logout / status)
- `backend/src/auth.rs`(`CurrentUser` extractor;HttpOnly cookie `listen_panel_session`;Argon2id PHC)
- 前端:`frontend/src/lib/auth.tsx` + `auth-context.tsx` + `pages/Auth.tsx`(Setup / Login / Register)+ `App.tsx::RequireAuth`

**改密码**:目前没 UI。停服务 → SQLite 改 `users.password_hash` 为新的 Argon2id PHC 字符串。**不要 DELETE users 行**,关联级联清空。

### 2.2 Materials CRUD
- `backend/src/routes/materials.rs` + `media.rs`(上传 / Range 流)
- `models.rs::Material`(`language` / `source_type` / `source_ref` / `text` / `text_source`)
- 前端:`pages/Library.tsx` / `Editor.tsx` / `Reader.tsx` + `components/VideoPlayer.tsx`

### 2.3 Library 语言 tab
- `frontend/src/pages/Library.tsx` — `LANG_TABS`、`loadInitialLang/saveLang`、`localStorage['listen-panel:library-lang']`
- 后端无需改。过滤纯前端 `materials.filter(m => m.language === language)`。

### 2.4 Vocab / 查词 / 朗读
- `backend/src/routes/vocab.rs` / `llm.rs`(`/api/lookup`) / `tts.rs`(`/api/tts/speech`)
- `backend/src/config.rs::TtsConfig`(provider=`azure`,`region`,`voice_id_en`,`voice_id_ja`,`output_format`)
- `backend/src/language.rs::Language::lookup_*_prompt`
- 前端:`components/AddVocabDialog.tsx` / `VocabPanel.tsx` / `SpeakButton.tsx` / `lib/llm.ts` / `lib/audio.ts`

**TTS provider 切换**:全在 `config.rs` + `routes/tts.rs::azure_speech`。换 provider(如回 ElevenLabs / OpenAI TTS / 本地 Kokoro):新增 `TtsProvider::*` variant + 对应 `<provider>_speech()` 实现 + dispatch。**缓存 key 含 provider/voice**,自动失效。

### 2.5 高亮 + 释义 popover
- `frontend/src/lib/highlight.tsx` — 词形按长度倒序 + escape + `\b(...)\b` 正则,idiom 用 dotted underline
- `frontend/src/components/HighlightedWord` 在 `highlight.tsx` 内部 — Portal 挂 body,fixed 定位 + clamp + 滚则关

### 2.6 ASR 转写
- `backend/src/routes/asr.rs` + `models.rs`(`TranscriptionJob` + `transcript_segments`)
- `backend/src/config.rs::AsrConfig`
- 远程 worker 协议见 README §4.8。改协议时同时改 `asr-worker/worker.py`。
- 前端:Reader 顶栏「生成原文」+ 轮询 `/api/transcriptions/:id`

### 2.7 翻译分析(study)
- `backend/src/study.rs`(批处理 + `transcript_segment_studies` 写入 + progress / stage 更新)
- `backend/src/language.rs::Language::study_system_prompt` — 改语法点 / 搭配的抽取风格在这
- 前端:Reader 「翻译分析」按钮 + `TranscriptSegmentBlock` 渲染

**`EOF while parsing a list` 复盘**:DeepSeek 默认 `max_tokens=4096`,长段合并后撞顶被截断。修复:`study.rs::call_study_llm` 写死 `max_tokens=8192`(`deepseek-chat` 硬上限)。再撞需要缩短每批段数或降单段字符上限。

### 2.8 News(自动抓取 / 评分 / furigana)
- 详细见 `docs/news-shadowing.md`
- 关键文件:
  - `backend/src/news_fetcher.rs` — `CHANNELS` 常量 + `english_system_prompt` / `japanese_system_prompt` + 抓取调度
  - `backend/src/youtube.rs` — Data API + yt-dlp 字幕抓取(注意 `fetch_captions` 接受 `language` 参数,`sub_langs = format!("{language}.*")`)
  - `backend/src/furigana.rs` — 5 段一批的 ruby 标注 + HTML sanitize 白名单 `<ruby>` / `<rt>`
  - `backend/src/routes/news.rs` — `?language=` 过滤 + 三个 backfill admin 端点
- 前端:`pages/News.tsx`(双 tab + 质量评语显示)+ `App.tsx`(`/news` → `/news/en` 重定向)

**多字节截断复盘**:`news_fetcher::transcript_for_prompt` 早期写 `out.truncate(15000)`,日语 1 字符 = 3 bytes,15000 byte 切到 codepoint 中间,Rust 直接 panic。修复:`while cut > 0 && !out.is_char_boundary(cut) { cut -= 1; }` 找回 char 边界再 truncate。

**ElevenLabs → Azure 切换复盘**:EL Free Tier 反滥用系统会无差别 401 `detected_unusual_activity`,跟 credits 无关。建议长期 Azure(F0 Tier 500K chars/月稳定),不要回 EL。

### 2.9 随手记
- `backend/migrations/20260523150000_quick_notes.sql`(quick_notes 表)
- `backend/src/routes/quick_notes.rs`(POST / GET / DELETE / PATCH;LLM 调用 `temperature=0.3` / `max_tokens=4000` / 输入 char 上限 4000)
- `backend/src/language.rs::Language::quick_note_*_prompt`
- 前端:`pages/QuickNotes.tsx` + `components/QuickNoteDialog.tsx` + `components/Layout.tsx`(浮按钮 + 全局快捷键监听)

PATCH 字段语义:**只更新提供的字段**,空字段不动;`source: null` 才能清空;`highlights / grammar` 数组项前后端各 trim 一次 + drop 空项。

### 2.10 备份
- `backend/src/routes/backup.rs`(VACUUM INTO + spawn_blocking + tar+gzip + JSON key 脱敏 + open-fd-after-unlink)
- 前端:`pages/Settings.tsx` 底部 `<a href="/api/settings/backup">`

JSON 脱敏规则在 `redact_in_place`:递归扫,key 名小写后 `contains("key|token|secret")` 的字符串值改写 `"***"`。空字符串保留。**新增同性质字段(如 `password`、`credential`)需要更新这个列表**。

### 2.11 Reader 段落↔视频同步
- `frontend/src/pages/Reader.tsx`:
  - `findVideoProgressSeconds(materialId)` — 扫 `localStorage['listen-panel:video-progress:<id>:*']`,VideoPlayer 自己存的
  - `findParagraphIndexForTime(segments, text, ms)` — 在 `lib/sentence.ts` 或 Reader 内部辅助函数
  - 恢复策略:savedSec 存在 + segments 有 → scroll 到对应段;无 → fallback `listen-panel:article-scroll:<id>`
- 保存触发:`beforeunload` + `visibilitychange='hidden'`

### 2.12 跟读速度档(0.75 / 0.85 / 1 / 1.25 / 1.5)
- `frontend/src/pages/Reader.tsx::ShadowingControls::RATES`
- 应用:`useEffect(() => playerHandleRef.current?.setPlaybackRate(rate), [rate])`(**不要轮询**,见复盘)
- VideoPlayer 三种源都支持(local 精确;YouTube 取整到 0.25/0.5/0.75/1/1.25/1.5/1.75/2;Bilibili no-op)

**轮询复盘**:早期 `setInterval(1000ms)` 反复下发 `setPlaybackRate` 防 YT 自重置。YT iframe 在 buffering / 切换时收 postMessage 会刷 36 万 + 个错误,浏览器卡死。教训:**只在状态变化时下发,不要主动定时刷**。

---

## 3. localStorage Key 索引

统一前缀 `listen-panel:`。增删时同步这里。

| Key | 类型 | 写入方 | 用途 |
|---|---|---|---|
| `listen-panel:library-lang` | `'en' \| 'ja'` | `Library.tsx` | 上次书架 tab |
| `listen-panel:article-scroll:<materialId>` | number(scrollTop)| `Reader.tsx` | 文章 scroll 恢复(fallback) |
| `listen-panel:study-visible:<materialId>` | `'1' \| '0'` | `Reader.tsx` | 翻译分析显示开关 |
| `listen-panel:furigana-on` | `'1' \| '0'` | `Reader.tsx` | 假名 toggle 默认值 |
| `listen-panel:video-progress:<materialId>:<source>` | number(seconds)| `VideoPlayer.tsx` 三种子组件 | 播放进度,Reader 段落同步用 |
| `listen-panel:default-volume`(在 `lib/settings.ts`)| number | Settings + `LocalVideo` | 本地视频默认音量 |

**废弃**(可能旧浏览器还有):`listen-panel:materials`、`listen-panel:seq`、`listen-panel:vocab`、`listen-panel:vocab_seq`(localStorage 时代的数据,REST 化后弃用)。

---

## 4. LLM Prompt 在哪改

| 用途 | 文件 | 函数 |
|---|---|---|
| 查词(lookup) | `backend/src/language.rs` | `lookup_system_prompt(lang)` |
| 分段翻译分析(study) | `backend/src/language.rs` | `study_system_prompt(lang)` |
| 随手记分析 | `backend/src/language.rs` | `quick_note_system_prompt(lang)` |
| 新闻抓取分析(EN) | `backend/src/news_fetcher.rs` | `english_system_prompt()` |
| 新闻抓取分析(JA) | `backend/src/news_fetcher.rs` | `japanese_system_prompt()` |
| Furigana 标注 | `backend/src/furigana.rs` | `japanese_system_prompt()` |

所有调用都用 `response_format: { type: "json_object" }`。改 prompt 前先想清楚返回 schema,JSON 解析失败会整批 fail。

---

## 5. 数据流速查

### 新闻自动入库 → 用户消费
```
news_fetcher (3h cron)
  ↓ YouTube Data API + yt-dlp
news_items 表(quality + furigana + idioms_json)
  ↓ 用户在 /news 点"加入书架"
POST /api/news/:id/import
  ├→ materials 新行
  ├→ transcript_segments(从 segments_json 展开)
  ├→ vocab(kind='idiom',从 idioms_json 展开)
  └→ spawn study task + (JA only) furigana task
```

### 用户在 Reader 点"翻译分析"
```
POST /api/transcriptions/:id/study
  → study.rs::run_study
    → segment_chunks(每批 ≤8 段 / ≤5000 字)
    → 每批 call_study_llm(DeepSeek JSON mode, max_tokens=8192)
    → 写 transcript_segment_studies(逐批,前端轮询时已能看到)
```

### TTS 朗读
```
SpeakButton → audio.ts provider 链
  ├→ POST /api/tts/speech(Azure SSML)→ 落盘缓存 → audio/mpeg
  ├→ Free Dictionary mp3(英语 only)
  └→ speechSynthesis(浏览器,fallback)
```

---

## 6. 历史决策速查(踩过的坑)

| 时间 | 决策 | 原因 |
|---|---|---|
| 2026-05-23 | study `max_tokens=8192` | DeepSeek 默认 4096,长段截断 → EOF |
| 2026-05-23 | setPlaybackRate 改 useEffect 一次性下发 | 1s 轮询触发 YT postMessage 36 万 + 错误把浏览器卡死 |
| 2026-05-23 | Azure 替换 ElevenLabs | EL Free 反滥用 401,跟 credits 无关,封号 |
| 2026-05-23 | `transcript_for_prompt` 加 char_boundary 截断 | 日语 3-byte 字符在 byte 边界 panic |
| 2026-05-23 | Library 强制按语言 tab | 混显长列表里夹杂另一语言影响阅读节奏 |
| 2026-05-23 | 段落↔视频时间同步优先于 scrollTop | 视频恢复但文章在顶端的错位用户感觉是 bug |
| 2026-05-23 | 备份用 VACUUM INTO + tar 流式 + open-fd-after-unlink | 跑着也能导 + 大文件不吃内存 + 断开不留垃圾 |
| 2026-05-23 | News 质量阈值 7,锚点描述 | 让 LLM 拿到尺度,实际通过率 ~97% |
| 2026-05-23 | Furigana 服务端预生成 + sanitize 白名单 | 前端不调 LLM,渲染零延迟;HTML 严格白名单防 XSS |
| 2026-05-04 | 高亮 popover Portal + fixed | 左栏 `overflow-y-auto` 会裁切 |
| 2026-05-03 | DeepSeek key 后端 `config.json` | 浏览器存 key 风险大;`.env` 不便运行时改 |
| 2026-05-03 | Editor 上传改"保存时传" | `onChange` 即传产生大量孤儿 mp4 |
| 2026-05-03 | ref-count cleanup | 防替换文件时误删被别处引用的上传 |

---

## 7. 跨语言一致性检查清单

加新语言或改 prompt 时跑一遍:

- [ ] `backend/src/language.rs::Language` 加 variant
- [ ] 五个 prompt 函数都实现(lookup / study / quick_note / news EN / news JA;有 furigana 需求加 furigana)
- [ ] `MaterialLanguage` union(`frontend/src/types.ts`)同步
- [ ] Library / News tab 加 `LANG_TABS` 项
- [ ] TTS voice_id 在 `TtsConfig` 加默认值 + Settings 页字段
- [ ] yt-dlp 字幕抓取 `--sub-langs {lang}.*` 已动态 — 不需要改
- [ ] 高亮 / 朗读 fallback 按语言切换覆盖

---

## 8. 测试快速参考

跑测试:
```bash
cd backend && cargo test          # Rust 后端
cd frontend && npm run typecheck  # TS 严格检查
cd frontend && npm run build      # Vite 产物校验
```

常用手动验证:
- `curl -X POST localhost:9527/api/news/_refresh -b 'listen_panel_session=<admin>'` — 即时跑一次抓取
- `curl -X POST localhost:9527/api/news/_backfill_quality -b ...` — 给老 news 补打分
- `curl -X POST localhost:9527/api/news/_backfill_furigana -b ...` — 给老 JP 材料补假名
- `curl 'localhost:9527/api/settings/backup' -b ... -o backup.tar.gz` — 导备份

---

## 9. 改东西前的快速 sanity check

1. **grep 这个东西现在用在哪里**:`rg "<符号>" backend frontend docs`
2. **看 CHANGELOG 有没有相关决策**:`grep -i "<keyword>" CHANGELOG.md`
3. **改数据模型?加 migration,不要改老 migration**(sqlx 按 timestamp 顺序跑)
4. **改 LLM prompt 前**:返回 JSON schema 也跟着变?所有调用方的 parse 都要查一遍
5. **大改前先 commit 一次**:`git log fe89607..HEAD` 翻最近改动,合并冲突防身

# Listen Panel

一个本地用的英语听力 + 口语练习面板。Notion 风格 UI,**左原文 / 右视频**,支持 YouTube / Bilibili / 本地 mp4。可选词加生词,LLM 给上下文相关释义,生词在原文里高亮、点击弹释义卡,可翻卡片复习。所有数据落本机 SQLite。

> 这是一份会随实现持续更新的活文档。改了代码就回头改这里。

---

## 1. 仓库结构

```
listen-panel/
├── backend/                     Rust + Axum + SQLite
│   ├── Cargo.toml
│   ├── migrations/
│   │   └── 20260503000001_init.sql      sqlx 自动跑
│   ├── src/
│   │   ├── main.rs              AppState + router + 监听 0.0.0.0:9527
│   │   ├── db.rs                SqlitePool + 启动迁移
│   │   ├── paths.rs             用户数据目录解析 + data-dir.json 设置
│   │   ├── config.rs            LlmConfig + 数据目录内 config.json 读写
│   │   ├── error.rs             AppError → IntoResponse
│   │   ├── models.rs            Material / Vocab / ASR DTO
│   │   ├── study.rs             转写后分段翻译、语法和固定搭配讲解
│   │   └── routes/
│   │       ├── mod.rs
│   │       ├── materials.rs     materials CRUD + 文件 cleanup 钩子
│   │       ├── vocab.rs         vocab CRUD
│   │       ├── media.rs         上传 + Range 流 + 孤儿清理
│   │       ├── llm.rs           /api/lookup,代理到 DeepSeek
│   │       ├── tts.rs           /api/tts/speech,代理到 TTS provider
│   │       ├── auth.rs          /api/auth/* 本地账户与 session
│   │       ├── asr.rs           /api/*/transcriptions,远程 ASR worker 适配
│   │       └── settings.rs      GET/PUT /api/settings/llm/tts/asr
│   └── data/                    gitignored
│       ├── app.db
│       ├── config.json          DeepSeek 凭据(api_key/base_url/model)
│       ├── tts.json             TTS 凭据(provider/api_key/base_url/voice_id/model/output_format)
│       ├── asr.json             远程 ASR worker 配置(base_url/token/model 等)
│       ├── tts-cache/           TTS 生成音频缓存(有文章上下文时按 material 分目录)
│       └── uploads/             本地视频 (uuid 命名)
├── frontend/                    React 19 + Vite + TS + Tailwind v4
│   ├── package.json
│   ├── vite.config.ts           /api 代理到 :9527
│   └── src/
│       ├── main.tsx
│       ├── App.tsx              路由
│       ├── api.ts               fetch 封装
│       ├── types.ts             DTO
│       ├── index.css
│       ├── components/
│       │   ├── Layout.tsx       顶栏
│       │   ├── VideoPlayer.tsx  三种源统一封装
│       │   ├── SelectionPopup.tsx
│       │   ├── AddVocabDialog.tsx
│       │   └── VocabPanel.tsx
│       ├── pages/
│       │   ├── Library.tsx      书架
│       │   ├── Editor.tsx       新建/编辑(含拖放上传)
│       │   ├── Reader.tsx       左文右视频主页
│       │   ├── Vocab.tsx        全局生词本
│       │   ├── Review.tsx       翻卡复习
│       │   └── Settings.tsx     DeepSeek/TTS/ASR 设置
│       └── lib/
│           ├── settings.ts      localStorage 设置
│           ├── llm.ts           DeepSeek lookupWord
│           ├── sentence.ts      句子定位
│           └── highlight.tsx    原文高亮 + 点击 popover
├── docs/
│   └── gpu-compute-platform.md  GPU 计算平台版本规划
├── asr-worker/                  GPU 机器上运行的 FastAPI 通用计算 worker
│   ├── worker.py                `/v1/jobs` 通用 Job API + `/v1/transcribe` 兼容协议
│   ├── requirements.txt
│   ├── .env.example
│   └── README.md
├── dev.sh                       一键启动
└── README.md                    本文档
```

## 2. 技术栈

**后端**
- Rust 2024 edition
- `axum` 0.7(`multipart`, `macros` features — `macros` 给 `FromRef` 派生)
- `tokio` 1
- `sqlx` 0.8(`runtime-tokio-rustls`, `sqlite`, `chrono`, `migrate`, `macros`)
- `tower-http` 0.5(`cors`, `trace`)
- `reqwest` 0.12(`rustls-tls`, `json`,跟 sqlx 共用 rustls)用于代理 DeepSeek/TTS/ASR,以及读取外链视频标题
- `tracing` + `tracing-subscriber` (`env-filter`, `fmt`)
- `anyhow` / `thiserror`
- `uuid` v4 / `tokio-util` (`io`) / `serde` / `chrono`(`serde`)

**前端**
- React 19 + TypeScript
- Vite 8
- Tailwind v4 via `@tailwindcss/vite`
- `react-router-dom`

**外部依赖**
- DeepSeek `chat/completions`(JSON mode):用于生词释义。**Key 存在数据目录的 `config.json`**(gitignored),前端通过 `POST /api/lookup` 走后端代理,key 不出服务端。
- ElevenLabs Text to Speech:用于生词朗读。**Key 存在数据目录的 `tts.json`**(gitignored),前端通过 `POST /api/tts/speech` 走后端适配层,key 不出服务端。
- 远程 GPU worker:用于视频转写。当前 ASR 仍兼容 `POST /v1/transcribe`;worker 也提供通用 `POST /v1/jobs`、`GET /v1/jobs/:id`、`GET /v1/jobs/:id/result` V1 API,后续可扩展 TTS/OCR/embedding 等 GPU workload。长期规划见 `docs/gpu-compute-platform.md`。
- YouTube oEmbed / Bilibili `x/web-interface/view` API:用于新建材料时根据链接自动识别视频源并读取标题;Bilibili 会额外读取分 P、aid、cid 和时长,用于外链播放器和 worker 下载定位。Bilibili API 失败时再回退解析视频页 HTML;最终失败时只回退为手动标题或链接本身,不阻塞保存。

## 3. 数据模型

### `materials`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | autoincrement |
| user_id | INTEGER | FK 到 users,材料 owner |
| title | TEXT | |
| source_type | TEXT | CHECK ∈ `'local' / 'youtube' / 'bilibili'` |
| source_ref | TEXT | local→`<uuid>.<ext>`,youtube→URL/ID,bilibili→`BV...` 或 `BV...?p=2&cid=...&aid=...` |
| text | TEXT | 原文,空行分段 |
| notes | TEXT | 备注 |
| created_at | TEXT | ISO 8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`) |
| updated_at | TEXT | 同上,PUT 时刷新 |

### `vocab`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| material_id | INTEGER | FK,**ON DELETE CASCADE** |
| word | TEXT | 实际选中的词形,小写 |
| lemma | TEXT | LLM 给的原形 |
| phonetic | TEXT? | IPA |
| pos | TEXT? | n. / v. / adj. ... |
| definition_zh | TEXT | 主释义(必填) |
| definition_en | TEXT? | |
| example_zh | TEXT? | 原句中文翻译 |
| context | TEXT | 加词时所在句 |
| mastery | INTEGER | CHECK 0..3 |
| created_at | TEXT | |

启动时 `PRAGMA foreign_keys = ON`,删材料级联清生词。

### `users`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| username | TEXT UNIQUE | 登录名,大小写不敏感 |
| display_name | TEXT | 顶栏显示 |
| password_hash | TEXT | Argon2id PHC string |
| is_admin | INTEGER | 0/1;第一个初始化账户为 admin |
| created_at | TEXT | |

### `sessions`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| user_id | INTEGER | FK 到 users,ON DELETE CASCADE |
| token_hash | TEXT UNIQUE | session token 的 SHA-256,不存明文 token |
| created_at | TEXT | |
| expires_at | TEXT | 默认 30 天 |

### `uploads`
| 字段 | 类型 | 说明 |
|---|---|---|
| file | TEXT PK | 数据目录 `uploads/` 下的存储文件名 |
| user_id | INTEGER | FK 到 users,限制 local 材料只能绑定自己的上传文件 |
| created_at | TEXT | |

### `transcription_jobs`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| user_id | INTEGER | owner |
| material_id | INTEGER | FK 到 materials,ON DELETE CASCADE |
| provider | TEXT | V1 为 `remote_faster_whisper` |
| model | TEXT | 默认 `large-v3` |
| language | TEXT | 默认 `en` |
| status | TEXT | `queued/running/succeeded/failed` |
| progress | INTEGER | 0..100;worker 阶段回调更新,成功/失败时置 100 |
| error | TEXT? | 失败原因 |
| study_status | TEXT | `pending/running/succeeded/failed/skipped`;ASR 成功后的分段学习讲解状态 |
| study_error | TEXT? | 学习讲解失败或跳过原因 |
| study_progress | INTEGER | 0..100;分段翻译分析进度 |
| study_stage | TEXT | 当前分析阶段,如 `分析第 2/8 批` |
| media_token_hash | TEXT? | local 视频给 worker 回连读取时的一次性 token hash |
| created_at/updated_at/completed_at | TEXT | |

### `transcript_segments`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| job_id | INTEGER | FK 到 transcription_jobs |
| material_id | INTEGER | FK 到 materials |
| start_ms/end_ms | INTEGER | segment 时间戳 |
| text | TEXT | segment 文本 |

### `transcript_segment_studies`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| segment_id | INTEGER | UNIQUE FK 到 transcript_segments,ON DELETE CASCADE |
| job_id | INTEGER | FK 到 transcription_jobs |
| material_id | INTEGER | FK 到 materials |
| translation_zh | TEXT | 当前 segment 的自然中文翻译 |
| grammar_points | TEXT | JSON 数组,每项含 `title/explanation_zh/evidence?/tip_zh?` |
| usage_points | TEXT | JSON 数组,每项含 `phrase/meaning_zh/note_zh?/example?` |
| created_at/updated_at | TEXT | |

## 4. 后端实现细节

### 4.1 启动流程(`main.rs`)
1. 初始化 `tracing_subscriber`,默认 filter `info,tower_http=debug,sqlx=warn`
2. `paths::init()` 解析用户数据目录并打印启动日志。优先级:`LISTEN_PANEL_DATA_DIR` 环境变量 → `backend/data-dir.json` → 默认 `backend/data`
3. `routes::media::ensure_dirs()` 建 `<数据目录>/uploads/`
4. `routes::tts::ensure_cache_dir()` 建 `<数据目录>/tts-cache/`
5. `db::pool()`:确保数据目录存在 → `SqliteConnectOptions::create_if_missing(true).foreign_keys(true)` → `sqlx::migrate!("./migrations").run(&pool)`
6. `config::load()` 读 `<数据目录>/config.json` → `Arc<RwLock<LlmConfig>>`,文件缺失就用默认值并 warn 一行
7. 组装 `AppState { pool, http: reqwest::Client, llm: SharedLlm, tts: SharedTts, asr: SharedAsr }`(用 axum `FromRef` 派生,handler 可直接取需要的字段);reqwest client 设置 20s timeout
8. `Router::new().nest("/api", routes::api_router(state))` + `CorsLayer::permissive()` + `TraceLayer::new_for_http()`
9. 监听 `0.0.0.0:9527`(Vite 19527 走 proxy 转发到这里)

### 4.2 路由表(均以 `/api` 为前缀)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/materials` | 列表,按 `updated_at` DESC |
| POST | `/materials/metadata` | `{source_ref}` → 自动识别 YouTube/Bilibili,返回 `{source_type, source_ref, title}`;只请求白名单视频站点标题 |
| GET | `/materials/:id` | 详情;404 找不到(经 `AppError` 映射) |
| POST | `/materials` | 新建,服务端写 created_at/updated_at |
| PUT | `/materials/:id` | **局部更新**,SQL 用 `COALESCE(?, col)` |
| DELETE | `/materials/:id` | 204;级联清 vocab(FK)+ 清 local 文件 |
| GET | `/vocab[?material_id=N]` | 列表,可按材料筛 |
| POST | `/vocab` | 新建 |
| PUT | `/vocab/:id` | 局部更新 |
| DELETE | `/vocab/:id` | 204 |
| POST | `/upload` | multipart `file`;白名单 `mp4 / mkv / webm / mov / m4v`;DefaultBodyLimit 2 GiB;返回 `{file: "<uuid>.<ext>"}` |
| GET | `/media/:file` | Range 流式;200 / 206;Accept-Ranges + Content-Range;路径校验 |
| GET | `/settings/llm` | 返 `{configured, base_url, model}`,**永不返 api_key** |
| PUT | `/settings/llm` | 局部更新 `{api_key?, base_url?, model?}`,空字符串字段视为不变;写盘 `<数据目录>/config.json` 同时刷新内存 |
| POST | `/lookup` | `{word, context}` → 走 DeepSeek 兼容协议 → `{lemma, phonetic, pos, definition_zh, ...}`;未配置 key 直接返 500 + `not configured` 文案 |
| GET | `/settings/tts` | 返 `{configured, provider, base_url, voice_id, model, output_format}`,**永不返 api_key** |
| PUT | `/settings/tts` | 局部更新 `{api_key?, base_url?, voice_id?, model?, output_format?}`,空字符串字段视为不变;写盘 `<数据目录>/tts.json` 同时刷新内存 |
| POST | `/tts/speech` | `{text, material_id?}` → 先查 `<数据目录>/tts-cache/`;传 `material_id` 时按文章目录缓存,未命中时走 ElevenLabs `text-to-speech/:voice_id`,成功后缓存并返回 `audio/mpeg`;未配置 key 返回 503 |
| GET | `/auth/status` | `{needs_setup, user}`;未登录 user 为 null |
| POST | `/auth/setup` | 首次初始化管理员账户,并把旧材料归属给该用户 |
| POST | `/auth/register` | 创建普通账户并登录 |
| POST | `/auth/login` | 校验用户名密码,设置 HttpOnly session cookie |
| POST | `/auth/logout` | 删除当前 session,清 cookie |
| GET | `/settings/asr` | 返 `{configured, provider, base_url, token_configured, backend_base_url, model, language, beam_size, vad_filter, condition_on_previous_text, timeout_seconds}`,**永不返 api_token** |
| PUT | `/settings/asr` | 局部更新远程 ASR worker 配置;空 token 保留现有 |
| POST | `/settings/asr/health-check` | 管理员手动检测 GPU worker `/health` 和 `/v1/capabilities`;可传 `{base_url, api_token?}` 检查未保存的公网/隧道地址,不返回 token |
| GET | `/settings/data-dir` | 返 `{active_dir, configured_dir, pending_dir, source, restart_required}`;管理员可见 |
| PUT | `/settings/data-dir` | 保存 `{data_dir}` 到 `backend/data-dir.json`,重启后生效;如果已设置 `LISTEN_PANEL_DATA_DIR` 则拒绝覆盖 |
| POST | `/materials/:id/transcriptions` | 为当前用户材料创建转写任务,后台调用远程 worker |
| GET | `/materials/:id/transcriptions` | 当前材料转写任务列表 |
| GET | `/transcriptions/:id` | 单个任务状态,包含 `study_status/study_error/study_progress/study_stage` |
| GET | `/transcriptions/:id/segments` | 任务与 segments;每个 segment 可带 `study`(译文、语法点、固定搭配) |
| POST | `/transcriptions/:id/study` | 按需启动当前转写任务的分段翻译、语法和固定搭配分析 |
| GET | `/asr/media/:job_id` | 仅 worker 用;local 视频转写时凭 `Authorization: Bearer <一次性token>` 读取原始上传文件 |
| POST | `/asr/progress/:job_id` | 仅 worker 用;凭同一个一次性 token 回调 `{progress, stage?}` 更新转写进度 |

### 4.3 错误处理
`AppError(anyhow::Error)`,blanket `From<E: Into<anyhow::Error>>`。`IntoResponse` 实现:
- `sqlx::Error::RowNotFound` → 404
- 其它 → 500
- 体 `{"error": "<message>"}`,同时 `tracing::error!` 一行

### 4.4 文件管理:`media::delete_upload_if_orphan(pool, source_ref)`
两道闸 + 一次系统调用:
1. **路径校验**:空 / `..` / `/` / `\` → 跳过
2. **引用计数**:`SELECT COUNT(*) FROM materials WHERE source_type='local' AND source_ref=?`,>0 跳过(防别的 material 在用)
3. `tokio::fs::remove_file`,`NotFound` 静默,其它 IO 错打 `warn` 日志

调用点:
- `materials::update`:对比读到的 old vs 写完的 new,若 old 是 local 且(切走 / source_ref 改变)→ 清旧文件
- `materials::delete_one`:DELETE 之前先 fetch_optional row → DELETE → 若 row 是 local → 清文件

PUT 同值(只改 title 之类)走 COALESCE 保留旧值,`row.source_ref == old.source_ref`,跳过清理。

### 4.5 时间戳
`chrono::DateTime<Utc>` 端到端。schema 默认 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`(带毫秒、Z),与 sqlx-chrono 解析格式兼容。

### 4.6 用户数据目录(`paths.rs`)
- 默认数据目录是 `backend/data/`,保持旧版本行为。这个目录包含 SQLite、上传视频、TTS 缓存和各类凭据 JSON。
- 可用环境变量覆盖:
  ```bash
  LISTEN_PANEL_DATA_DIR="$HOME/listen-panel-data" ./dev.sh
  ```
- 也可以在设置页的“数据存储”填写目录。保存后写入 `backend/data-dir.json`(gitignored),**重启服务后生效**。运行中不热切换,避免 SQLite 连接池、上传流、TTS 缓存目录在请求中途改变。
- 环境变量优先级最高。设置了 `LISTEN_PANEL_DATA_DIR` 时,设置页只展示当前目录,不能覆盖。
- 系统不会自动搬迁旧数据。要保留旧数据,先停服务,再把旧 `backend/data/` 内容复制到新目录,然后设置新目录并重启。

### 4.7 配置持久化(`config.rs`)
- 类型 `Arc<RwLock<LlmConfig>>`,放进 `AppState.llm`
- 启动时 `tokio::fs::read_to_string("<数据目录>/config.json")` → `serde_json::from_str` → fallback 到 `Default`(`base_url=https://api.deepseek.com`、`model=deepseek-chat`、`api_key=""`)
- `PUT /api/settings/llm` 写内存 → `serde_json::to_string_pretty` → 写同目录 `.tmp` → `tokio::fs::rename` 原子替换
- API key 字段:空字符串 / 未传都视为"保留现有",只有非空字符串才覆盖。这样前端"留空提交"按钮才不会误清
- `TtsConfig` 单独持久化到 `<数据目录>/tts.json`,默认 `provider=eleven_labs`、`base_url=https://api.elevenlabs.io`、`voice_id=JBFqnCBsd6RMkjVDRZzb`、`model=eleven_multilingual_v2`、`output_format=mp3_44100_128`。保存规则同 LLM,key 不回传前端。
- `AsrConfig` 单独持久化到 `<数据目录>/asr.json`,默认 `provider=remote_faster_whisper`、`base_url=http://127.0.0.1:8765`、`backend_base_url=http://127.0.0.1:9527`、`model=large-v3`、`language=en`、`beam_size=5`、`vad_filter=true`、`condition_on_previous_text=false`、`timeout_seconds=7200`。`api_token` 可选,空字符串 / 未传都视为保留现有。

### 4.8 远程 ASR worker 协议
- 后端创建 `transcription_jobs` 后启动后台 task。任务切到 `running`,调用 `POST <base_url>/v1/transcribe`。
- 对 local 材料,请求体包含 `media_url=http://<listen-panel后端>/api/asr/media/<job_id>` 和 `media_token`;worker 从这个 URL 拉视频时带 `Authorization: Bearer <media_token>`。该 token 只在 job `queued/running` 时有效,完成/失败后清空 hash,且不会出现在 URL 日志里。
- 请求体也包含 `progress_url` 和 `progress_token`;worker 在字幕、下载、ffmpeg、模型加载、ASR segment 进度等阶段 POST 回调后端,前端轮询 `GET /api/transcriptions/:id` 看到实时进度。
- 对 YouTube/Bilibili,请求体不含 `media_url`,worker 直接使用 `source_type/source_ref`;GPU 机器侧可用 `yt-dlp` 先拉字幕/音频,再走 faster-whisper。Bilibili 的 `source_ref` 可包含 `p/cid/aid`;worker 会转成 `https://www.bilibili.com/video/<BV>?...` 交给 `yt-dlp`。

请求 JSON:
```json
{
  "job_id": 1,
  "source_type": "local",
  "source_ref": "xxxx.mp4",
  "media_url": "http://192.168.0.113:9527/api/asr/media/1",
  "media_token": "...",
  "model": "large-v3",
  "language": "en",
  "beam_size": 5,
  "vad_filter": true,
  "condition_on_previous_text": false,
  "progress_url": "http://192.168.0.113:9527/api/asr/progress/1",
  "progress_token": "..."
}
```

响应 JSON:
```json
{
  "text": "optional full text",
  "segments": [
    { "start": 0.0, "end": 4.2, "text": "Hello world." }
  ]
}
```

后端以 `segments` 为准写入 `transcript_segments`,并把所有 segment 文本用空行合并后写回 `materials.text`。如果没有 segments,则用响应里的 `text` 生成单段。

### 4.9 按需分段翻译与分析
- worker 返回转写结果后,后端只持久化 `transcript_segments` 和 `materials.text`,并把 ASR job 标记为 `succeeded`;不会自动调用 LLM。
- 用户在 Reader 点击 `翻译分析` 后,前端调用 `POST /api/transcriptions/:id/study`,后端再复用现有 LLM 配置生成学习讲解。这个流程不要求 GPU worker 更新协议。
- 学习讲解按最多 8 段 / 约 5000 字符一批调用兼容 OpenAI 的 `chat/completions` JSON mode。每完成一批就写入 `transcript_segment_studies`,并更新 `study_progress/study_stage`,所以长文章会逐步显示已完成段落,不用等全文分析完。
  - `translation_zh`:自然中文翻译
  - `grammar_points`:常用语法说明,如虚拟语气、现在完成时、过去完成时、被动语态、从句、非谓语、情态动词等,但只说明文本里真实出现且有学习价值的结构
  - `usage_points`:固定用法、固定搭配、phrasal verbs、介词搭配、常见句型等
- 如果 LLM key 未配置,`study_status` 置为 `skipped`;如果讲解调用失败,`study_status` 置为 `failed` 并记录 `study_error`。这些失败不影响原文转写成功。
- `GET /api/transcriptions/:id/segments` 会把 `transcript_segment_studies` 左连接到 segment 上,前端用 `segment.study` 展示译文、语法和搭配。

## 5. 前端实现细节

### 5.1 路由
| 路径 | 页面 |
|---|---|
| `/` | Library 书架 |
| `/new` | Editor 创建 |
| `/m/:id` | Reader 阅读+视频 |
| `/m/:id/edit` | Editor 编辑 |
| `/vocab` | 生词本 |
| `/review` | 复习 |
| `/settings` | DeepSeek key |

### 5.2 全局布局(`Layout.tsx`)
- 容器 `h-screen flex flex-col overflow-hidden` —— **整页定长**,避免子页 overflow 触发不到
- 顶栏 `h-14`,Logo + 三个 NavLink + 设置 + `+ 新建`
- 子页通过 `<Outlet />` 渲染,内层用 `flex-1 overflow-y-auto` 自管滚动

### 5.3 Reader(`pages/Reader.tsx`)
- 上方子标题栏:返回 / 标题 / `□ 高亮生词` 开关 / `生词 (N)` 按钮 / 分栏比例 / 均分 / 编辑
- 主区两列,中间 1px 分隔条 `cursor-col-resize`,鼠标拖拽改 `leftPct`(28-78% 区间)
- 左:`<article ref={articleRef}>`,如果 `materials.text` 已按空行分成多段,优先按文本段落渲染;否则使用转写 segments 分组渲染;没有 segments 时按 `materials.text` 的 `\n\n` 分段回退。开高亮时,每段走 `highlightText()` 渲染
- 转写完成后顶栏出现 `翻译分析` 按钮。默认关闭,不触发 LLM;点击后才生成并显示中文译文、语法点、固定用法/固定搭配。分析中会显示等待提示、当前批次、百分比进度和已完成段数;已完成批次会先出现在正文里。再次点击会隐藏分析内容,不会删除已生成结果。
- 左侧文章滚动容器按 `materialId` 把 `scrollTop` 存到 `localStorage`(`listen-panel:article-scroll:<id>`),切走页面或刷新后回到上次阅读位置
- 右:`<VideoPlayer>`
- 同时挂 `<SelectionPopup>`、`<AddVocabDialog>`(条件渲染)、`<VocabPanel>`(条件渲染)

### 5.4 视频播放(`components/VideoPlayer.tsx`)
- `local`:若 `source_ref` 已是 URL/blob/`/api/` 起头,直用;否则拼 `/api/media/${encodeURIComponent(sourceRef)}`,经 Vite proxy 透传到后端 Range 端点。子组件 `LocalVideo` 用 callback ref 在挂载时把 `video.volume` 设为 `settings.default_volume`,监听 `onVolumeChange` 把用户的调整写回 `settings.default_volume`(下次任何本地视频起播都用这个值)
- `youtube`:正则提 11 位 ID,`<iframe src="https://www.youtube.com/embed/<id>">`(音量走 YouTube 自己的控件,不受 default_volume 影响)
- `bilibili`:解析 `BV...?p=<page>&cid=<cid>&aid=<aid>`;旧的 BV-only 材料会在播放时调用 metadata 接口补 cid/aid。iframe 使用 `bvid/p/page/cid/aid/isOutside/autoplay=0`,避免多 P 视频被固定到错误分 P。
- 三种视频源都会保存播放进度并在重新进入材料时恢复到该位置,但不会自动播放;恢复完成后保持暂停状态。

### 5.5 Editor(`pages/Editor.tsx`)
- 视频源类型按钮:youtube / bilibili / local;粘贴 YouTube/Bilibili 链接或 ID 后会防抖调用 `POST /api/materials/metadata`,自动切到正确来源并规范化保存用的 `source_ref`
- 标题不再强制手填。用户未手动改过标题时,外链标题会自动回填;抓取失败或无标题时,保存用视频链接/ID 兜底。
- **拖放区(local 时显示)**:虚线框,`onDragEnter/onDragOver/onDragLeave/onDrop`,用 `dragDepthRef` 计数避免子节点闪烁
- 点击拖放区 → `fileInputRef.current?.click()` 触发隐藏 `<input type=file>`,选完 `e.target.value=''` 重置以便选回同一文件
- **挑/拖时只暂存**(`pendingFile: File | null`),**不发请求**;预览块显示文件名 + 大小 + "保存时才上传"(已有 source_ref 多一行"将替换原文件")
- 前端先卡白名单 `mp4/mkv/webm/mov/m4v`
- `save()` 三态:`idle / uploading / saving`;按钮文案随之变;若 `pendingFile` 存在,先 `POST /api/upload` 拿名字,再 PUT/POST materials

### 5.6 选词加词
1. 在 `<article>` 内选文(<= 80 字)→ `SelectionPopup` 用 `getBoundingClientRect()` 在选区下方浮出"+ 加为生词"按钮
2. 点击 → 找 `data-paragraph` 段落 → `findSentence(para, offset)` 用 `[.!?](?=\s|$)` 切句,定位选区所在句作为 context
3. 弹 `AddVocabDialog`:调 `lib/llm.ts::lookupWord(word, context)` → DeepSeek `response_format: json_object` 返结构化释义
4. 用户可改任何字段(必改 `definition_zh`)→ 确认后 `createVocab(...)`,Reader 立即重新拉本材料 vocab 列表 → 高亮生效、计数 +1

### 5.7 高亮 + 点击释义(`lib/highlight.tsx`)
- 给定段落和 vocab 列表,把 word 字段按长度倒序、escape 后拼成 `\b(w1|w2|...)\b` 大小写不敏感正则,`exec` 走全段文本,命中处替换为 `<HighlightedWord>` 组件
- `<HighlightedWord>` 自管 `open` 状态(各高亮独立),光标 `pointer`,**点击切换 popover**
- popover 通过 **React Portal** 挂到 `document.body`,`position: fixed` + `getBoundingClientRect()` 算坐标,这样不被左栏 `overflow-y-auto` 裁;靠近左/右视口边缘自动 clamp 到 12px 边距内;在视口下半屏的词改成往上弹;父容器一滚就关掉(位置会错,close 比 follow 简单可靠);宽 22rem,内含词、lemma/音标/词性、中文释义、英文释义、原句中译;琥珀色 `bg-amber-100`
- 关闭策略:再次点击同词 / 文档级 `mousedown` 命中 `<mark>` 之外 / 切到别的高亮词。点击 popover 内部不会关
- V1 限制:只匹配实际词形,不做词形还原。"running" 不会匹配 "ran"

### 5.8 复习(`pages/Review.tsx`)
- 进入页选范围(全部 / 单一材料)+ 是否包含 mastery=3
- `Fisher-Yates shuffle` 出队列,逐张展示
- 卡片正面:词 + 音标 + 上下文(目标词遮成 `bg-stone-200 text-stone-200` 同色块当 cloze)
- 翻面后显示词性 + 中文释义 + 英文释义 + 原句中译
- 三档判定:`不记得`(mastery=0) / `模糊`(不变) / `记得`(+1,封顶 3),走 `updateVocab`
- 队列耗尽显示"复习完成",可"再来一轮"

### 5.9 Settings(`pages/Settings.tsx`)
两块区块,一次保存:
- **DeepSeek**(走后端 `/api/settings/llm`)
  - API Key 输入框(隐藏/显示切换);右上角状态徽标 `● 已配置 / ○ 未配置`,从 `GET /api/settings/llm` 读
  - 已配置时 placeholder 显示 `已配置 ●●●●●● (留空保留现有 key)`,留空提交不覆盖
  - Base URL(改用兼容 OpenAI 协议的代理时填这里)
  - 模型(默认 `deepseek-chat`)
  - 保存只 PUT 实际改了的字段;成功后清空 key 输入框,状态徽标刷新
- **ElevenLabs TTS**(走后端 `/api/settings/tts`)
  - API Key 输入框(隐藏/显示切换);右上角状态徽标 `● 已配置 / ○ 未配置`,从 `GET /api/settings/tts` 读
  - 已配置时 placeholder 显示 `已配置 ●●●●●● (留空保留现有 key)`,留空提交不覆盖
  - Base URL(默认 `https://api.elevenlabs.io`)
  - Voice ID(默认 `JBFqnCBsd6RMkjVDRZzb`,可改成用户 ElevenLabs Voices 里的 voice id)
  - 模型(默认 `eleven_multilingual_v2`)
  - 输出格式(默认 `mp3_44100_128`)
- **远程 ASR Worker**(走后端 `/api/settings/asr`)
  - Worker Base URL:GPU 机器上的 worker 地址,如 `http://192.168.0.50:8765`
  - 健康检查:从 listen-panel 后端请求 worker 的 `/health` 和 `/v1/capabilities`,用于验证局域网、公网或隧道地址是否可达,并显示 device、compute type、capabilities 和延迟
  - Backend Base URL:GPU 机器回连本机后端读取 local 视频的地址,如 `http://192.168.0.113:9527`
  - Shared Token:可选 worker 鉴权 token;仅保存,不回传前端
  - 模型默认 `large-v3`,语言默认 `en`,Beam Size 默认 5,超时默认 7200 秒
  - VAD 默认开,`condition_on_previous_text` 默认关,减少长视频重复/跑偏
- **播放**(本地 localStorage)
  - 本地视频默认音量(0-100% slider,默认 30%);Reader 起播时用,播放中调整也写回

### 5.10 账户与数据隔离
- 首次访问如果没有用户,前端进入 `/setup`,创建第一个管理员账户。该账户会接管迁移前已有的全部 materials/vocab。
- 后续局域网用户可在 `/register` 创建普通账户。普通账户默认看到空书架,只能访问自己创建的 materials/vocab/local media;local 材料还会校验 `uploads.user_id`,不能手动绑定别人的上传文件名。
- 后端用 HttpOnly `listen_panel_session` cookie 保存会话 token;数据库只存 token 的 SHA-256 hash。session 默认 30 天过期。
- 受保护 API:materials/vocab/media/upload/lookup/tts/transcriptions 都要求登录。DeepSeek/ElevenLabs/ASR 设置只允许 admin 访问,避免局域网匿名用户消耗 key 或查看配置状态。

### 5.11 `api.ts`
- `request<T>(path, init?)`:统一设 `Content-Type: application/json`(除非传了 FormData,但目前 api.ts 不处理上传)、`!ok` 抛带后端 `{error}` 文案的 Error、204 返回 undefined
- `getOrNull<T>`:404 → null,其它失败抛
- 所有 Material/Vocab CRUD 直对后端,**导出签名跟早期 localStorage 版本完全一致**,Library/Editor/Reader/Vocab/Review 调用方零改动

### 5.12 视频转写 / ASR
- Reader 顶栏有 `生成原文` 按钮。点击后 `POST /api/materials/:id/transcriptions`,后端创建 job 并后台调用远程 ASR worker。
- 前端每 2.5 秒轮询 `GET /api/transcriptions/:id`;成功后重新拉 `GET /api/materials/:id` 和 `GET /api/transcriptions/:id/segments`,显示 worker 写回的 `materials.text`。
- `翻译分析` 默认关闭。点击后调用 `POST /api/transcriptions/:id/study`,再继续轮询 `study_status/study_progress/study_stage`;分析中也会重新拉 segments,把已完成批次先展示出来。
- V1 已保存 segments 和 segment study;后续可做字幕时间轴、点击句子跳转、AB 循环。
- 长视频不走收费 API。推荐 worker 先尝试已有字幕/自动字幕,没有再用 `faster-whisper large-v3` 本地 GPU 识别。

### 5.13 生词朗读
- 生词卡统一使用 `components/SpeakButton.tsx`,已接入 Reader 高亮弹卡、本篇生词抽屉、全局生词本、复习卡。
- 朗读策略在 `lib/audio.ts`,按 provider 链依次尝试:
  1. `remote-tts`:请求本机后端 `POST /api/tts/speech`,当前由 Rust 适配层代理 ElevenLabs,返回 `audio/mpeg`
  2. `dictionary-mp3`:请求 Free Dictionary API (`https://api.dictionaryapi.dev/api/v2/entries/en/<word>`) 找 `phonetics[].audio` 的 mp3
  3. `browser-speech`:前两档不可用时,自动 fallback 到浏览器 `speechSynthesis`
- ElevenLabs 音频按 `provider/base_url/voice_id/model/output_format/text` 做 SHA-256 hash;有文章上下文时缓存到 `<数据目录>/tts-cache/material-<material_id>/<provider>_<hash>.mp3`,没有文章上下文时缓存到 `<数据目录>/tts-cache/<provider>_<hash>.mp3`;命中缓存不再请求 ElevenLabs,不消耗 credits。失败结果不缓存。清缓存直接删 `<数据目录>/tts-cache/`。
- Free Dictionary 音频 URL 只做内存缓存(`Map<word, audio|null>`),不写数据库、不落盘。
- 浏览器朗读固定 `en-US`,语速 `0.9`;不同系统/浏览器的声音会不同。若后续要替换底层 TTS,优先扩展后端 `tts.rs` provider,保持前端 `remote-tts` 不变。

## 6. 启动方式

### 一键
```bash
./dev.sh
```
脚本同时拉起后端(:9527)和前端(:19527)。前端默认使用 `--host 0.0.0.0`,同一局域网内可访问 `http://<本机内网 IP>:19527/`。日志带 `[BE]` / `[FE]` 前缀。Ctrl-C 同时停。

指定数据目录启动:
```bash
LISTEN_PANEL_DATA_DIR="$HOME/listen-panel-data" ./dev.sh
```

### 分开两个终端
```bash
# 终端 A
cd backend  && cargo run
# 终端 B
cd frontend && npm run dev -- --host 0.0.0.0
```

### 浏览器访问
http://localhost:19527/
局域网访问示例:
http://192.168.0.113:19527/

### ASR worker
GPU 机器上:
```bash
cd asr-worker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m pip install -U yt-dlp
python worker.py
```

还需要系统里有 `ffmpeg`。详细配置见 `asr-worker/README.md`。

worker V1 已提供通用 GPU Job API:

- `GET /v1/capabilities`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/result`

目前 listen-panel 仍默认调用兼容接口 `POST /v1/transcribe`,避免影响现有转写流程。下一步可把后端 ASR 调用切到 `/v1/jobs` 并保留 `/v1/transcribe` fallback。

### 第一次跑要做的事
1. 打开 http://localhost:19527/ 或局域网地址
2. 首次进入 `/setup`,创建管理员账户。迁移前已有材料会归到这个账户。
3. 打开 http://localhost:19527/settings
4. 如需调整数据目录,在“数据存储”里填写目录,保存后重启。旧数据不会自动搬迁,需要手动复制旧 `backend/data/` 内容。
5. 填 DeepSeek API key(申请:https://platform.deepseek.com/api_keys)、ElevenLabs API key(申请:https://elevenlabs.io/app/settings/api-keys)和远程 ASR worker 地址→ 保存。**Key/token 落到数据目录的 `*.json`,不入数据库,不回传前端**
6. 回到书架,新建第一条材料

## 7. 已知限制 / 待办

### 已知小毛刺(行为正确,品味略差,不阻塞)
- 上传时给坏扩展 / `/api/media/..` 路径穿越,后端返 **500** 而非 400(请求被正确拒绝,只是状态码不规范)
- 高亮 V1 只匹配实际词形(存 "running" 不会高亮 "ran"),没做词形还原
- 生词朗读 V1 优先走本地 TTS 缓存,缓存未命中才请求 ElevenLabs 并消耗 credits;未配置、额度不足、网络失败时退回 Free Dictionary mp3 与浏览器 `speechSynthesis`
- ASR V1 不内置 GPU worker,只定义远程 worker 协议;worker 崩溃、网络断开或超时会把 job 标记为 failed。V1 没有取消任务和进度回传。
- 账户系统 V1 没有密码找回/管理员重置 UI。忘记密码只能本地操作 SQLite 或后续补 admin 用户管理页
- 复习无 SRS 算法,只是随机抽 + 三档手判 mastery
- "上传成功但 createMaterial/updateMaterial 失败"的瞬时窗口会留下纯孤儿(目前 cleanup 只在 update/delete 触发,不在 upload 失败回滚)

### 计划中
- 发音 / TTS V2:后端 `tts.rs` 扩展 OpenAI TTS 或本地 Kokoro/Piper provider,支持统一音色、整句朗读和可选缓存
- 字幕联动 / SRT 解析 + AB 循环(V2)
- ASR V2:worker 进度回调、任务取消、字幕优先策略状态展示、segments 时间轴 UI
- Axum 兼托管 `frontend/dist/`,做单二进制部署
- "导出 / 备份"按钮(导出 SQLite 到 .json)

## 8. 维护者备忘

- **改数据模型**:加新迁移文件 `migrations/<timestamp>_<desc>.sql` → `models.rs` → `routes/*.rs` → `frontend/src/types.ts` → `api.ts`(签名通常稳定)
- **新增视频源类型**(比如 vimeo):`types.ts` union 加项 → `VideoPlayer.tsx` 加 case → `Editor.tsx` TYPES 数组加项 → migration 改 CHECK 约束(单独迁移)
- **localStorage key**:统一前缀 `listen-panel:*`(`materials/seq/vocab/vocab_seq` 已废弃但旧浏览器还可能有,可手清)
- **端口分两处**:后端 `9527` 写在 `backend/src/main.rs` 的 `ADDR`;前端 `19527` 写在 `frontend/vite.config.ts` 的 `server.port`(同文件 `server.proxy['/api']` 指向后端 9527)。改后端口要相应改 `dev.sh` 与 `README.md` 的展示文案。
- **CORS 当前 permissive**:仅限开发期。后续若改成 Axum 兼托管 dist,可整层去掉
- **常见错误来源**:DeepSeek 返非 JSON / 网络断 / Cargo 依赖大版本变更
- **数据目录**:默认是 `backend/data/`,也可用 `LISTEN_PANEL_DATA_DIR` 或设置页改到其它位置。若通过设置页修改,写入的是 `backend/data-dir.json`,重启后才生效。
- **数据迁移到全新机器**:把当前数据目录整目录拷过去即可,SQLite(含用户/session/password_hash/transcript segments)+uploads/+tts-cache/+config.json(含 DeepSeek key)+tts.json(含 TTS key)+asr.json(含 ASR token)都在那。**注意这些 json 含密钥,跨机器拷贝要谨慎**

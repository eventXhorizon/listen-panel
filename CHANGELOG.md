# Changelog

只记**值得后人考古**的决策与里程碑(为什么这么选,排除了什么),不记 typo / 措辞调整。
最新在最上面。每次有不那么显然的决策时,写一笔到 `## [Unreleased]`,发版/打 tag 时再下沉到日期段。

---

## [Unreleased]

(暂无未归档条目)

## 2026-05-03

### 加 git 仓库 + CHANGELOG
- `git init` 在 `listen-panel/`,首笔 initial commit 入快照。从此每改一处就一笔 commit。
- **Why CHANGELOG vs git log**:git 是状态快照 + diff,适合"看代码怎么变"。CHANGELOG 是决策时间线,适合"看为什么这样选、排除了什么"。两者互补不重复。
- **Why 不重建 14 笔假 commit**:代码只剩当前态,凑出过往快照只能全部 stage 同一份文件、只换 message,污染时间线骗自己。CHANGELOG 把历史填了就够。

### 高亮 popover 用 React Portal
- 问题:左栏 `overflow-y-auto`(CSS 规范一轴非 visible 强制双轴非 visible),靠列左右边缘的高亮词 popover 被裁。
- 修法:`createPortal` 到 `document.body` + `position:fixed` + `getBoundingClientRect` 算坐标 + 视口 clamp(12px 边距)+ 下半屏自动翻上 + 父容器一滚就关掉。
- **Why 滚就关 vs 跟随滚动**:跟随要监听全部祖先滚动 + 实时重算坐标,复杂得多;关掉用户重新点开就是新坐标,简单可靠。

### DeepSeek key 改服务端 config.json
- 之前:浏览器 localStorage,前端直连 `https://api.deepseek.com`。
- 现在:`backend/data/config.json`(gitignored)+ `Arc<RwLock<LlmConfig>>` 在 `AppState` + axum `FromRef` 派生(旧 handler `State<SqlitePool>` 零修改)+ `POST /api/lookup` 代理 + `GET/PUT /api/settings/llm`。
- GET 永不返 api_key,PUT 空字符串字段不覆盖。前端 Settings 页面 placeholder `已配置 ●●●●●● (留空保留现有 key)`。
- **Why config.json vs .env**:运行时改更自然;服务端写自己 .env 要处理注释/换行/并发,反模式。
- **Why config.json vs SQLite**:用户备份 .db 时不容易顺手泄密;config 跟用户数据隔离干净。
- **Why 加 web UI vs 让用户编辑文件**:本地一个人用,UI 改更顺手,而且强制 server-side 持久化。

### 本地视频音量持久化
- 问题:HTML5 `<video>` 没有"记住上次音量"的浏览器原生行为,每次开都是 1.0,过响。
- 修法:`AppSettings.default_volume`(默认 0.3)→ `LocalVideo` 子组件 callback ref 起播应用 + `onVolumeChange` 写回 → `/settings` 加 slider。
- 子组件抽出来是因为 hook 不能写在 `if (sourceType==='local')` 条件分支里。
- **Why 只本地 mp4(V1)**:YouTube IFrame Player API 加 ~40 行,Bilibili 没文档;本地是真痛点,其它两家自带 cookie / 会话内记忆。

### 前端端口 19527
- Vite 默认 5173 改成 19527。`strictPort: true` 端口冲突报错而不是默默换号。
- **Why 不用默认 5173**:跨项目避免冲突。

### Editor 拖放区 + 上传时机改成"保存时才传"
- 问题:之前 `<input onChange>` 一触发就 `POST /api/upload`,用户每点/换/取消一次都落一份 mp4 在 `data/uploads/`。
- 修法:`pendingFile: File | null` 暂存,`save()` 三态(idle/uploading/saving)真按保存才走 upload。新增拖放区(`onDragEnter/Over/Leave/Drop` + `dragDepthRef` 计数防子元素闪烁)。
- 配套:后端 `media::delete_upload_if_orphan(pool, source_ref)`,在 PUT material(替换/source_type 切走)和 DELETE material 时跑 reference count(`SELECT COUNT WHERE source_type='local' AND source_ref=?`)+ 路径校验,确认无人引用才删。
- **Why staging vs 直传**:事务边界清晰,cancel/换文件不再产生孤儿;后端 cleanup hook 兜底 update/delete 路径上的替换。
- **Why ref-count 而不是直接 unlink**:防其他材料误删,理论上 uuid 唯一不会撞,但加几行 SELECT 是廉价的防御。

### 一键启动 + README 活文档
- `dev.sh`:同时拉 backend(:9527)+ frontend(:19527),色彩 prefix(`[BE]` 青 / `[FE]` 紫),`awk fflush()` 防缓冲,`pkill -P $$` 清理子进程。
- `README.md`:8 节实现细节文档,目录/技术栈/数据模型/后端细节/前端细节/启动/限制/维护备忘。**约定每动一处实现就同步它**。
- **Why README 是活文档而不是 ADR/MkDocs**:本地小项目,单文件维护成本最低,grep 也快。

### 后端 Phase 1-4(Rust + Axum + SQLite + REST 切换)
- Phase 1: Axum 骨架 + materials CRUD + 迁移自动跑 + AppError 映射(`sqlx::Error::RowNotFound → 404`,默认 500)
- Phase 2: vocab CRUD,GET 支持 `?material_id=N`
- Phase 3: `POST /api/upload`(multipart, 2GiB body limit, 白名单 mp4/mkv/webm/mov/m4v) + `GET /api/media/:file` Range 流式(206/200, 路径校验防穿越)
- Phase 4: 前端 `api.ts` 全换 fetch(签名零变,Library/Editor/Reader 五个调用方零修改);Vite proxy `/api → :9527`;Editor `onLocalUpload`、VideoPlayer local 拼路径
- **Why SQLite vs Postgres**:本地单用户,一个 .db 文件 = 全部数据,迁移备份直接拷
- **Why sqlx runtime queries vs offline 宏**:躲开 `DATABASE_URL` 编译期检查的麻烦
- **Why 端口 9527**:用户挑的,避开 Vite 5173 / 8080
- **Why `ON DELETE CASCADE`**:删 material 自动清 vocab,免应用层维护
- **Why CORS permissive**:仅开发期;后续若 Axum 兼托管 dist,可整层去掉

### 加 LLM 释义 + 高亮 + 复习
- 选中文本 → 浮出 `+ 加为生词` 按钮 → 模态框带 DeepSeek 异步查到的释义(可改)→ 保存
- `findSentence(para, offset)` 用 `[.!?](?=\s|$)` 切句,定位选区所在句作为 context 一并存
- 高亮:词形按长度倒序 + escape + 拼 `\b(...)\b` 大小写不敏感正则,命中处包成 `<HighlightedWord>` 自管 open 状态(每个高亮独立)
- popover 第一版用 Tailwind `group-hover:block` 纯 CSS;后改成点击触发(hover 太敏感影响阅读节奏);再后又改成 portal(见 5-03)
- /review 翻卡片 + 上下文 cloze + 三档 mastery(0-3,无 SRS 算法)
- /vocab 全局列表 + 搜索 + 按材料筛
- **Why DeepSeek vs 手填 vs Free Dict API**:上下文相关释义质量明显好,Free Dict 短语/变形覆盖差
- **Why 让用户改了再保存**:LLM 偶尔跑偏,5 秒人工把关比事后改更省事
- **Why 不上 SRS**:V1 先把"加词→列表→翻卡"打通,SRS 是单独大特性

### Reader 左右滚动锁问题
- 问题:整页一滚就锁定。
- 根因:Layout 根 `min-h-screen`(允许撑开),Reader 的 `overflow-y-auto` 因祖先无固定高度永不触发。
- 修法:Layout 根改 `h-screen overflow-hidden`,加 `min-h-0` 给 Outlet 容器;Library/Editor 的 `<main>` 自包一层 `flex-1 overflow-y-auto`;Reader 已经写好分栏滚动,只需父容器固定高度。

## 2026-05-02

### 初始前端脚手架
- Vite + React 19 + TS + Tailwind v4(`@tailwindcss/vite`)+ react-router-dom
- 三页:Library 书架(卡片网格)/ Editor 表单 / Reader 左文右视频(可拖拽分栏)
- `lib/highlight.tsx` / `components/{Layout, VideoPlayer}` / `pages/{Library, Editor, Reader}` / `api.ts` / `types.ts`
- 初版数据层:`api.ts` 全部 localStorage 实现,但**导出函数签名按未来 REST 设计**,后端就位时改 fetch 调用方零修改
- VideoPlayer:本地 → HTML5 `<video>`;YouTube → `<iframe youtube.com/embed>`(URL 解 11 位 ID);Bilibili → `<iframe player.bilibili.com>`(解 BV 号)
- **Why React vs Svelte/Vue/纯静态**:用户偏好 React,生态熟
- **Why 先 mock 后端 vs 同时起**:把 API 契约钉死再做后端,免来回返工
- **Why 三家视频源全支持**:用户要的;iframe 嵌入避开 OAuth
- **Why Notion 风格**:用户在三个 ASCII mockup 里挑的,长时间阅读最舒服
- **Why V1 不做字幕联动**:大特性,V1 先打通"并排 + LLM 释义"主流程

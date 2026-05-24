# Changelog

只记**值得后人考古**的决策与里程碑(为什么这么选,排除了什么),不记 typo / 措辞调整。
最新在最上面。每次有不那么显然的决策时,写一笔到 `## [Unreleased]`,发版/打 tag 时再下沉到日期段。

---

## [Unreleased]

### 2026-05-23 文档大整理
- README、docs/features.md、docs/maintaining.md、docs/news-shadowing.md、CHANGELOG.md 同步到当前实现状态。**约定**:CHANGELOG 记决策 / 为什么,README 记现状,features.md 记怎么用,maintaining.md 记改起来怎么改。

### 随手记可编辑(2026-05-23)
- PATCH `/api/quick-notes/:id` 接受 `translation_zh / highlights / grammar / source`,**只更新提供的字段**;数组项前后端各 trim + drop 空项;`source: null` 才清空。
- **Why 可编辑而不是"重新生成"**:LLM 偶尔抽偏,用户改一两行的代价比重新跑一轮 + 改正确的差不多,且重跑会丢前次的判定。

### 随手记功能落地(2026-05-23)
- 表 `quick_notes(user_id, text, language, translation_zh, highlights_json, grammar_json, source, created_at)`;`idx_quick_notes_user_created` 复合索引。
- 入口:Layout 左下角浮按钮(`position: fixed` 全页可见,Reader 全屏也在)+ 全局 `⇧⌘J` / `⇧⌃J` 快捷键。挂在 Layout 而非各页面是为了「看到一句话立刻记」不被路由打断。
- LLM 调用:`temperature=0.3` / `max_tokens=4000` / 输入 4000 char 上限。失败返 502 不丢草稿。
- **Why 跟生词本分开**:生词本绑材料,要先看视频才有数据;随手记是 app 外的备忘册,跟材料无关、永久保留,跟"听完整素材"的工作流性质不同。混在一起反而难找。

### 跟读速度档加 1.25 / 1.5(2026-05-23)
- 原档:0.75 / 0.85 / 1。新增 1.25 / 1.5。
- **Why 不挑 1.2 / 1.3**:跟 YouTube 原生支持的 0.25 step 对齐,YT iframe `setPlaybackRate(1.25)` 不会被取整丢档。1.5 是听力练熟的合理上限,2.0 信息密度过高无法吸收。

### 段落↔视频时间同步(2026-05-23)
- Reader 进入时:优先读 `listen-panel:video-progress:<materialId>:*`,反查 segment 所在段落 → `scrollIntoView({block:'start'})`。无视频进度或无 segments 时 fallback 到旧的 `listen-panel:article-scroll:<id>` scrollTop 策略。
- **Why segment 反查优先**:旧策略只恢复 scrollTop,视频续播在 8:32 但文章在最顶端,用户感觉是 bug。
- **Why fallback 而不是单一策略**:纯文本材料没 segments;旧材料没视频进度;一刀切会让某类材料丢恢复。

### 数据备份导出(2026-05-23)
- `GET /api/settings/backup`(admin only)→ 流式 `.tar.gz`:`app.db`(VACUUM INTO 一致性快照)+ `uploads/` + `tts-cache/` + JSON 配置(key 脱敏)。
- **Why VACUUM INTO 而不是 cp app.db**:`cp` 会撕开运行中后端的写事务,恢复时可能 `database disk image is malformed`。`VACUUM INTO` SQLite 自身保证一致性。
- **Why 流式 + spawn_blocking 而不是先全建后再发**:几个 GB 不应吃内存;tar 自身没 async API,blocking 跑工作线程不卡 runtime。
- **Why open-fd-after-unlink**:tarball 临时文件 open 后立即 `remove_file`,内核保留 inode 给已开的 fd。客户端断开 / panic 都不会留垃圾在 `$TMPDIR`。
- **Why JSON key 脱敏**:用户可能把备份扔进 git / 网盘 / 朋友,key 泄露成本高,脱敏后还能看到字段存在,恢复时知道要重填。

### Library 改成语言 tab(2026-05-23)
- 之前:英日材料混在一个网格,按更新时间排。
- 现在:顶部 `英语 / 日语` 两 tab,localStorage 记上次。
- **Why**:用户当下基本只想看一种语言,长列表里夹另一语言影响节奏。混显需求几乎不存在,切换又便宜。

### 新闻卡片显示质量评语(2026-05-23)
- 不再放进 hover tooltip,直接显示在卡片底部:`质量 8/10 · <reason>`。
- **Why 不用 tooltip**:用户要的是"为什么打这个分",hover 才看会错过;直接显示让筛选高质量素材时有理由可循。

### LLM 质量评分 + view count(2026-05-23)
- `news_items` 加 `quality (1-10) / quality_reason / view_count`。DeepSeek 在 idiom 分析里顺手返回质量分(锚点:9-10=NYT Daily / NHK 解説,7-8=WSJ explainer,5-6=松散,1-4=vlog)。`/api/news` 过滤条件 `quality IS NULL OR quality >= 7`。
- **Why 锚点描述**:不给 LLM 锚点,质量分聚集 5-6,区分度低。给锚点后实际通过率 ~97%(主要是 7-8 居多,9-10 极少),模型态度变审慎。
- **Why NULL 透传**:升级时老 news 未评分,直接全砍掉太粗暴;backfill admin 端点跑完才严格生效。
- **Why time-ordered + quality 过滤,而不是按质量排序**:用户要"最新且够好",纯按 quality 排会让 3 天前的 9 分老视频压住今天的 7 分新视频,违背新闻消费习惯。

### Furigana 服务端 LLM 标注(2026-05-23)
- 表 `transcript_segments` 加 `text_with_furigana TEXT?`。导入 JA 材料时后端 spawn `furigana::generate_for_job`,DeepSeek 按 5 段一批生成 `<ruby>漢字<rt>かんじ</rt></ruby>` HTML。
- 严格 sanitize:白名单只放行 `<ruby>` `</ruby>` `<rt>` `</rt>`,其余 HTML 字符 escape。
- **Why 服务端预生成而不是前端调用**:前端调 LLM 暴露 key + 每次 Reader 打开等几秒 + 重复消耗。服务端一次性生成,客户端零延迟。
- **Why 仅 N3+ kanji**:N4/N5 常用字大部分日语学习者已认,标注反成噪音;阈值由 prompt 指定。
- **Why sanitize 白名单**:服务端 LLM 输出走 `dangerouslySetInnerHTML`,不 sanitize 等于把 prompt injection 当 XSS payload 渲染。白名单比 strip-tags 更保险(不会因为 LLM 在 ruby 里嵌入 `<script>` 而漏过)。
- 老 JA 材料补:`POST /api/news/_backfill_furigana`(admin)。

### Azure Speech 替换 ElevenLabs(2026-05-23)
- 之前:ElevenLabs voice cloning 质量极好但 Free Tier 反滥用系统会无差别 401 `detected_unusual_activity`,跟 credits 余额无关。换 voice ID、换 IP 都无效。
- 现在:Azure F0 Tier(每月 500K chars 免费),`en-US-AriaNeural` + `ja-JP-NanamiNeural`。
- **Why Azure 而不是 OpenAI TTS / Kokoro**:OpenAI TTS 日语 voice 太少;Kokoro 本地跑要 GPU + 部署成本;Azure F0 配额对单租户朗读够用很久,日语 Nanami 评价稳定。
- **配置迁移**:`TtsConfig.provider` 改 `azure`,字段去掉 `base_url/model`,加 `region / voice_id_en / voice_id_ja`。老 `tts.json` 解析失败时 fallback 默认值,用户重填 key 即可。
- **Why 不留 ElevenLabs fallback**:维护两个 provider 增加 cache key 复杂度,EL 反滥用问题不解决保留也无意义。要回切就当一次性事件处理。

### 多字节字符截断 panic 修复(2026-05-23)
- `news_fetcher::transcript_for_prompt` 原本 `out.truncate(15000)`(byte 索引)。日语 UTF-8 1 字符 = 3 bytes,15000 byte 切到 codepoint 中间 → Rust `assertion failed: self.is_char_boundary(new_len)` 直接 panic。
- 修复:`while cut > 0 && !out.is_char_boundary(cut) { cut -= 1; } out.truncate(cut);` 找回 char 边界再切。
- **教训**:`str::truncate` 对所有"按字节数限长"的场景都是雷区,加测试 case 含 multibyte("あ".repeat(8000) = 24000 bytes)。

### setPlaybackRate 改 useEffect 单次下发(2026-05-23)
- 早期 `setInterval(1000ms)` 反复下发 `setPlaybackRate(rate)` 防 YT 自重置回 1。
- 问题:YouTube iframe 在 buffering / 切换源时收 postMessage 会刷 36 万 + 个错误,**浏览器卡死**(用户截图 359558 errors 才发现)。
- 修复:`useEffect(() => playerHandleRef.current?.setPlaybackRate(rate), [rate])` 只在切档时下发。YT 偶尔自重置回 1× 让用户再点一下 pill,代价远小于轮询。
- **Why 不监听 YT 的 onStateChange**:复杂度爆炸;实际 YT 自重置不常见,用户感知不强。

### study `max_tokens=8192`(2026-05-23)
- 现象:某些长段被合并后,翻译分析失败 `EOF while parsing a list at line 70 column 1`。
- 根因:DeepSeek 默认 `max_tokens=4096`。一段长文本的 translation + grammar_points + usage_points JSON 输出能撞顶,截断成无效 JSON。
- 修复:`study.rs::call_study_llm` 写死 `max_tokens=8192`(`deepseek-chat` 硬上限)。
- 备选:缩短每批段数 / 单段字符上限。当前规模(每批 ≤8 段 / ≤5000 字符)+ 8192 token 够用。

### YouTube 字幕按材料语言抓(2026-05-23)
- `youtube.rs::fetch_captions` 之前硬编码 `--sub-langs en.*`。日语视频抓字幕全失败 `has_captions=0`。
- 修复:`fetch_captions` 接 `language: &str` 参数,`let sub_langs = format!("{language}.*");` 让 yt-dlp 拉对应语种字幕(含变种 `en-US/ en-GB/ ja-JP` 等)。

### 8 频道扩展(2026-05-23)
- 之前 4 个英语频道。现在 4 EN(CNBC International / Bloomberg / WSJ / FT)+ 4 JA(テレ東BIZ / 日経電子版 / PIVOT / NewsPicks)。
- `ChannelDef` 加 `language: &'static str` 字段。
- **频道 ID 怎么查**:`curl ... | grep -oE '"externalId":"UC[A-Za-z0-9_-]+"'`。**别用** `channel/UC...` 路径正则,会抓到侧栏推荐频道。
- 已知:Nikkei 字幕覆盖率近 0(老视频几乎都没字幕),PIVOT 多 >60min 长视频,后续可能换。WBS 早期 ID `UCPTVd32fJj668E64Xg4zs1A` 是 squatter,正确 ID `UCkKVQ_GNjd8FbAuT6xDcWgg`(`@tvtokyobiz`)。

### 时长窗口 3-60 分钟(2026-05-23)
- 之前 3-30 min。扩到 3-60 min 是为了让"质量值得反复观看"的长 explainer 也进来。
- 字幕抓取在 60 min 视频上 yt-dlp 仍稳定,DeepSeek transcript 用 char cap + char_boundary 截断兜底。

### 加 Docker + GitHub Actions CI(2026-05-23)
- `deploy/` 加 Dockerfile + compose;`.github/workflows/` CI 跑 cargo build + npm build + cargo test。
- **Why 现在加而不是更早**:多设备同步需求(笔记本 + 服务器)开始浮现,容器化是最小代价的 reproducible 部署。

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

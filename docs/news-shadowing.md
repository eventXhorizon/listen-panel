# 新闻跟读功能设计与实现

`/news` 页面 + 跟读控件的完整设计记录,包含每个非显然决策的"为什么"。后续给日语等其他语种扩展时按这份文档走。

---

## 1. 目标

> 用真实语速的英语新闻视频做跟读训练,自动把陌生表达和复杂句子标出来。

具体到产品:

- 自动抓取 4 个固定来源的最新视频(BBC/CNBC 类财经新闻)
- 每条视频自动:抓字幕 + 中文翻译 + 语法点 + 固定搭配 + 8 个 idiom 用法
- 用户在 `/news` 浏览,一键导入到自己的书架
- 进 Reader 后:左原文 / 右视频,段落级展示译文+语法+搭配,可循环跟读、调速、句末停顿

---

## 2. 频道清单与选择理由

写死在 `backend/src/news_fetcher.rs::CHANNELS`。当前 4 个英语频道:

| source | Channel ID | 名称 | 为什么选这家 |
|---|---|---|---|
| `cnbc` | `UCo7a6riBFJ3tkeHjvkXPn1g` | CNBC International | 每日财经短报道、采访,3-10 min 主流时长 |
| `bloomberg` | `UCUMZ7gohGI9HcU9VNsr2FJQ` | Bloomberg(@business)| Bloomberg 在 YouTube 主要发布渠道,深度财经+科技 |
| `wsj` | `UCK7tptUDHh-RYDsdxO1-5QQ` | The Wall Street Journal | 商业 explainer、人物访谈,5-10 min 居多 |
| `ft` | `UCoUxsWakJucWg46KW5RsvPw` | Financial Times | 商业 + 市场分析,5-15 min |

### 选择标准
- **频率高**(每天有新内容更新)
- **5-15 分钟为主**(短到能做完整跟读,长到信息密度够)
- **人工字幕覆盖率 > 70%**(yt-dlp 拿不到字幕的视频会被跳过,不进入页面)
- **新闻内容严肃**,跳过 vlog / lifestyle / 综艺

### 走过的弯路
- `@BBCNews` 频道短片(<3 min)和 Shorts 占比太高,**信息密度低**,被换掉
- `@TheEconomist` 经济学人 essay 视频偏长(15+ min)且偏 culture/politics 而非财经,被换掉
- `@BloombergTelevision` 这个 handle 现在被韩国用户占了,Bloomberg 在 YouTube 的实际官方 handle 是 `@business`(显示名仍叫 Bloomberg Originals)

### Channel ID 怎么查
```bash
curl -sL -A "Mozilla/5.0" "https://www.youtube.com/@<handle>" \
  | grep -oE '"externalId":"UC[A-Za-z0-9_-]+"' | head -1
```
`"externalId"` 出现在频道页的内嵌 JSON 里,是最可靠的 channel ID 源。**不要**用 `channel/UC...` 路径正则——那个会抓到侧栏推荐频道。

---

## 3. 数据流

```
                ┌─ 进程内 tokio interval task (每 3h,启动延迟 45s)
                │
YouTube Data API ──→ playlistItems.list 每频道 20 条最近上传
                          │
                          ├─→ videos.list 批量(单次 50 ID = 1 quota unit)拿 metadata
                          │
                          ├─→ 时长筛:3-20 分钟之外的直接跳过(不调 yt-dlp 也不调 DeepSeek)
                          │
                          ├─→ yt-dlp 抓官方字幕(JSON3,优先人工,缺则自动)
                          │      └─ 失败 → has_captions=0 入库,前端不展示
                          │
                          ├─→ 段落合并:把 2-4 秒的 caption cue 合并成 600-900 字段落
                          │
                          ├─→ DeepSeek 一次调用产出 {topic, difficulty, idioms[8]}
                          │
                          └─→ 写入 news_items 缓存表
                                       │
/news 页面 ←──── GET /api/news ────────┘
   │
   └─ "加入书架" → 创建 Material + transcript_segments + vocab(kind='idiom')
                          │
                          └─→ 自动 spawn 已有的 study task(逐段译文+语法+搭配)
                                       │
                                       └─→ Reader 自动展开 study(provider='youtube_caption' → showStudy=true)
```

---

## 4. 为什么用 yt-dlp 抓字幕

直接 HTTP 请求 YouTube 的 `timedtext` 接口(无论拿不拿 `ytInitialPlayerResponse` 的签名 URL),**2024-2025 年开始全部返 200 + 空 body**。这是 YouTube 反爬升级的结果——他们要求请求带 `potoken` 等浏览器侧 JS 生成的凭证,纯 HTTP 客户端拿不到。

yt-dlp 维护了客户端轮换、签名解码、cookies、各种 fallback 的列表,而且**频繁更新**(几乎每周一次)。我们 spawn 它做字幕抓取等于把"和 YouTube 打猫鼠"的活外包出去。

实现要点(`backend/src/youtube.rs::fetch_captions`):

```rust
yt-dlp --quiet --no-warnings --no-playlist \
       --write-subs --write-auto-subs --skip-download \
       --sub-langs en.* --sub-format json3 \
       -o <unique-prefix> <url>
```

- `--write-subs --write-auto-subs` 同时传:yt-dlp 优先取人工字幕,缺则取自动
- `--skip-download` 不下载视频本体(我们只要字幕)
- `--sub-langs en.*` 通配 `en`、`en-US`、`en-GB` 等所有英文变体
- `-o <prefix>` 输出路径前缀,UUID 保证并发不冲突
- 60 秒 timeout(`tokio::time::timeout`),`kill_on_drop` 保证 task 被丢弃时进程被清理
- 落盘后 Rust 直接 `tokio::fs::read` + `serde_json::from_slice`,复用 JSON3 解析器
- 用完 `tokio::fs::remove_file` 清

**部署要求**:`yt-dlp` 二进制必须在 PATH 里。安装:`brew install yt-dlp` 或 `pip install -U yt-dlp`。**保持新版本**,YouTube 反爬一变就要 update。

---

## 5. 段落合并:为什么 + 怎么做

### 问题
YouTube 字幕以"显示节奏"切片:每个 caption cue 2-4 秒,~30-50 字符。一句话经常被切成 2-3 段。直接当 transcript_segments 存的话:

- Reader 每个 caption 一张 study 卡 → 极度碎片化
- DeepSeek 也按 caption 分析 → 一段 10 分钟视频要 150+ 次 LLM 调用,贵且无意义
- "循环这段"按钮粒度是 2-4 秒,跟读时刚开口就结束

### 方案
`youtube::merge_into_paragraphs` 在 `json3_to_segments` 之后把零碎 cue 合并成 600-900 字的段落。规则(常量都在 `youtube.rs` 顶部):

| 触发断点的条件 | 阈值 |
|---|---|
| 句尾标点 `.!?。！？` + 累计 ≥ MIN_CHARS + 句数 ≥ TARGET_SENTENCES | 320 字 + 3 句 |
| 句尾 + 句数 ≥ MAX_SENTENCES | 6 句 |
| 字数 ≥ TARGET_CHARS 且(句尾 或 字数 ≥ MAX) | 650 字 / 900 字 |
| 说话间停顿 ≥ PARA_GAP_MS(自然换气) | 1.8 秒 |

### 末尾零碎处理
最后一个累积段如果字数 < MIN_CHARS:
- 若**没有**经过 gap-break(说明是文章自然结尾的零碎尾巴)→ 合并回上一段
- 若**经过了** gap-break(说明是说话人停顿后的真实新段落)→ 保留独立

效果:**150 段 → 5-10 段**,DeepSeek 调用降到原来 1/15-1/30,study 卡和"循环这段"按钮粒度终于 useful。

---

## 6. 导入流程的细节

`POST /api/news/:id/import` 在一个 transaction 里:

1. 查 `news_items`,确认 `has_captions=1`,反序列化 segments + idioms
2. **去重**:同用户 + 同 `yt_video_id` 已导入过 → 直接返回旧 Material(幂等)
3. 创建 Material(`source_type='youtube'`, `source_ref=<11 字 video_id>`, `text_source='manual_subtitle'`)
4. `materials.text` 用 `\n\n` 连接段落,Reader 文本视图能看到段落分隔
5. 创建合成的 `transcription_job`(`provider='youtube_caption'`, `status='succeeded'`, `study_status='pending'`)
6. 展开 segments 进 `transcript_segments`(每个段落一行)
7. 8 个 idiom 进 vocab(`kind='idiom'`,phrase 进 `word`/`lemma`、meaning_zh 进 `definition_zh`、usage_note 进 `example_zh`、anchor_sentence 进 `context`)
8. commit
9. **后台 spawn study task**(`study::generate_segment_studies_for_job`)——和用户在普通材料上点"翻译分析"是同一个函数,复用现有所有逻辑(批处理、进度回写、JSON 解析、容错)

前端在 Reader 看到 `provider='youtube_caption'` 就默认 `showStudy=true`,导入后直接看到译文/语法/搭配陆续出现。

**注意**:`study::call_study_llm` 写死 `max_tokens=8192`(DeepSeek 默认 4096 太小)。长段合并后的翻译 + 语法 + 搭配 JSON 输出能撞 4096 截断,表现为 `EOF while parsing a list at line N`。8192 是 `deepseek-chat` 硬上限,实测够用;再撞需要缩短每批段数或单段字符上限。

---

## 7. Reader 跟读控件

`Step 6` 加的,跟新闻功能解耦但配合使用:

- **速度**:0.75× / 0.85× / 1× / 1.25× / 1.5× — 切档时通过 `useEffect` 单次下发 `VideoPlayerHandle.setPlaybackRate`。**早期实现是 1 秒轮询防 YouTube 自重置**,导致 iframe buffering 时刷 36 万 + postMessage 错误把浏览器卡死,已改成只在切换时下发。YT 偶尔自重置回 1× 让用户再点一下,代价远小于轮询。
- **句末停顿**:0 / 0.5s / 1s / 2s — 循环时每过一次段末暂停这么久,留出跟读时间
- **每段时间戳旁 `↻ 循环` 按钮**:开循环后,setInterval 100ms 轮询 currentTime,过 end_ms 就 pause → 等 stop pause → seek to start_ms → play

`VideoPlayer` 通过 `handleRef` prop 暴露 `{ play, pause, seekTo, setPlaybackRate, getCurrentTime }`:
- `local` 用原生 `<video>` API
- `youtube` 用 iframe player API
- `bilibili` 给 no-op handle(postMessage 协议没接,暂不支持)

注意:YouTube `setPlaybackRate(0.85)` 实际会被取整到 0.75 或 1(YouTube 只保证 0.25/0.5/0.75/1/1.25/1.5/1.75/2),本地视频精确。

---

## 8. 安全:API key 不进日志

`reqwest::Error` 通过 `error_for_status_ref` 拿到时 Display 会把请求 URL 也带出来,包含 `&key=AIza...`。`tracing::warn!("{e:#}")` 默认就把 key 印到日志里。

`news_fetcher::redact_api_key` 用纯字符串扫描把 `key=<value>` 替换成 `key=REDACTED`。所有可能含 YouTube URL 的 `tracing::warn!` 都包了一层。

注意 value 终止符:**alphanumeric + `-_.~`** 以外的字符都断,不能用空格/`&`/`)` 简单匹配——会漏掉 `key=abc,k2=def` 这种逗号分隔的情形。

---

## 9. 配置 + 运维

### 环境变量
- `YOUTUBE_API_KEY`(必需):Google Cloud Console → APIs & Services → YouTube Data API v3。每日免费配额 10000 units,实际用量 ~100 units/天。
- `.env` 文件在项目根,`dev.sh` 启动时自动 source。模板见 `.env.example`。

### 外部依赖
- **yt-dlp** 二进制(`brew install yt-dlp` / `pip install -U yt-dlp`),保持最新版本

### 手动触发
admin 账号在浏览器 console:
```js
fetch('/api/news/_refresh', { method: 'POST' }).then(r => r.json()).then(console.log)
```
返回 `{added: N}`。每次重读 env 里的 key,所以 key 轮换不需要重启。

### Schema 演进策略
`news_items.source` 列上故意**没加 CHECK 约束**(migration `20260521000000_news_source_drop_check.sql` 把原 CHECK 去掉了),为的是换频道时不用每次写迁移。源 enum 值由 `news_fetcher::CHANNELS` 单点定义,前端 `News.tsx` 的 `SOURCES` / `SOURCE_LABEL` 跟着同步即可。

### 用户删除
`DELETE /api/news/:id`(admin only)→ 全局删除。前端每张卡片有 🗑 按钮,带 confirm。

---

## 10. 成本估算

| 步骤 | 调用频率 | 单次成本 | 备注 |
|---|---|---|---|
| YouTube Data API | ~100 units/天 | 免费(10k 配额) | playlistItems + videos.list |
| yt-dlp | ~30 次/天 | 免费 | 仅当时长合规才调 |
| DeepSeek idiom 抽取 | 1 次/视频 | ~¥0.01 | 在 news_fetcher 里 |
| DeepSeek study 生成 | 5-10 次/导入视频 | ~¥0.01-¥0.03/批 | 只在用户点导入时跑 |

每条新闻**预先**只花 ~¥0.01(idiom),**导入后**花 ~¥0.1-0.3(study)。用户只为真正阅读的内容付费。

---

## 10.5 质量评分(LLM 内置打分 + 阈值过滤)

DeepSeek 的 idiom 抽取调用顺带返回:

- `quality` 整数 1-10
- `quality_reason` 一句中文,说明为什么这个分数

prompt 里给了具体锚点(避免模型主观漂移):
- **9-10**:NYT Daily / 60 Minutes / NHK 解説 级别 — 长留人话术、专业领域语言、思路完整
- **7-8**:WSJ / Bloomberg / テレ東BIZ explainer — 清晰、有信息、可学习点充足
- **5-6**:能看但松散,信息密度低、重复
- **1-4**:vlog 风、宣传、断章碎念

`GET /api/news` 的过滤条件是 `has_captions = 1 AND (quality IS NULL OR quality >= 7)`。NULL 透传是为了**避免 schema 升级后老数据一夜消失** —— 之后 admin 跑一次 backfill 把它们填满,阈值才生效。

阈值 7 在生产数据下约 95-97% 通过率(我们这 4 家英文 + 4 家日文都是严肃媒体,本身就鲜有 <7 内容)。模型上限实际打到 8,9-10 几乎没见过,说明锚点描述把 9-10 设得足够"高不可攀",好。

### 回填端点
`POST /api/news/_backfill_quality`(admin only)— 对所有 `quality IS NULL` 的 news_items 重跑 `analyze()`(覆盖 topic/difficulty/idioms 顺手填 quality+reason)。返回 `{scored, kept, dropped, failed}`,触发方式同 `/api/news/_refresh`:

```js
fetch('/api/news/_backfill_quality', { method: 'POST', credentials: 'same-origin' })
  .then(r => r.json()).then(console.log)
```

`view_count` 列从 `videos.list?part=statistics` 拿,目前**只存不排** —— 排序还是 `published_at DESC`(用户优先看到最新)。view_count 作为未来扩展(可作为同 quality 下的 tiebreaker),先存着不亏。

---

## 10.6 时长策略变更

原先 4-15 分钟太严(FT 长 explainer 全掉了)。改成 **3-30 分钟**,然后又改成 **3-60 分钟**,理由:

- 高质量长片(PIVOT 类对谈)值得反复跟读,不该被时长筛掉
- **质量过滤接管把关**:即便 60 分钟视频通过时长筛,质量分够才进 /news

副作用:对 PIVOT 这种平均 30+ 分钟的频道,合规率本就低,放宽到 60min 也常常只捞 0-1 条。

---

## 10.7 Furigana(振り仮名)— 日语专属

`transcript_segments.text_with_furigana TEXT`(NULL 表示未生成)。导入日语新闻后,后端在 study task 旁边再 spawn 一个 `furigana::generate_for_job`:

- 按 5 段一批送 DeepSeek
- prompt 要求**只标 JLPT N3 以上的 kanji**(N4-N5 常用字保留素颜),专有名词 / 行业用语 / 难读复合词积极标注
- 一个词整体一个 ruby:`<ruby>経済産業省<rt>けいざいさんぎょうしょう</rt></ruby>`,不逐字拆
- 输出**严格 sanitize**:只放行 `<ruby>` 和 `<rt>` 标签,其余 `<>&` 全转义。前端可以放心 `dangerouslySetInnerHTML`

Reader 里日语材料默认开「假名」toggle(localStorage 持久),关掉后回退到纯文本 + 生词高亮。

### 回填端点
`POST /api/news/_backfill_furigana`(admin only)— 跑所有 youtube_caption JA jobs 里 `text_with_furigana IS NULL` 的段。返回 `{jobs, annotated}`。

### CSS
`.reader-ruby` 加 line-height 2 防挤压;`<rt>` 0.55em 字号,muted 颜色,low-emphasis 上方小字。

---

## 11. 给其他语种加的步骤(对日语和将来的语种)

这套架构有 7 个明显的"语言无关"点和 5 个需要按语种定制的点。要加 `ja`:

### 11.1 复用不动的(语言无关)
1. 整体数据流(playlist → videos → captions → analyze → DB)
2. 时长过滤
3. yt-dlp subprocess(`--sub-langs <code>.*`)
4. 段落合并算法(中英日通用,标点表里加 `。！？`)
5. `news_items` schema(已有 `language` 列)
6. 导入流程(创建 Material + transcription_job + segments + vocab)
7. Reader 跟读控件、idiom 高亮

### 11.2 需要按语种定制的
1. **频道清单**:`CHANNELS` 加一组日语频道(NHK / TV 东京 BIZ / 日経 / PIVOT / NewsPicks 等),每个要带 `language: "ja"` 字段
2. **DeepSeek prompt**:idiom 抽取要用日语 prompt(参考 `language.rs::Language::lookup_user_prompt` 的 `ja` 分支)。study 已经按 material.language 切换,自动 OK
3. **idiom 概念**:日语里"地道表达"更多指惯用句、四字熟語、和制表現,不是 phrasal verbs。prompt 要明确教 LLM 要抽什么
4. **句尾标点表**:`merge_into_paragraphs` 的 `'.' | '!' | '?' | '。' | '！' | '？'` 已经包含日语,可能要加 `」』`(引用结束)等收尾符
5. **/news 前端的语言筛选**:UI 上需要加语言切换(英语 / 日语),后端 `GET /api/news` 加 `?language=` 过滤参数

### 11.3 实施顺序建议
1. 重构 `CHANNELS` 加 `language` 字段,后端按 channel 的 language 调用对应 prompt
2. `GET /api/news` 加 `?language=` 过滤
3. 前端 `/news` 按语言路由(`/news/en`、`/news/ja`),`/news` redirect 到 `/news/en`
4. 调试 1-2 个日语频道的字幕抓取(yt-dlp 对日语字幕的覆盖率 + 质量)
5. 写日语 idiom 抽取 prompt 并 A/B 几条视频看效果
6. 完整一轮:监控日志,看每个频道的 added/skipped 比例,调整时长筛和频道选择

### 11.4 日语实际经验(已落地)

| 频道 | 字幕覆盖率 | 备注 |
|---|---|---|
| **テレ東BIZ** (`@tvtokyobiz`) | 高 | 标题 metadata 里就有,人工字幕齐全 |
| **日経電子版** (`@nikkei`) | **0%** | Nikkei 不给视频上字幕,全部 `has_captions=0` 进 DB 但列表不显示 |
| **NewsPicks** | 中高 | 字幕齐 |
| **PIVOT 公式** | n/a | 内容平均 30-90 分钟,绝大多数被时长筛刷掉(进入率 ~1-2 条/20)|

**坑点**:
- `--sub-langs en.*` 是 yt-dlp 必须按语言传(原先写死 en,导致日语字幕全部抓不到)
- 字幕的多字节字符要小心:`out.truncate(BYTE_CAP)` 会在 UTF-8 中间 panic。日语 3 字节/字,15000 字节切位置容易撞到字符中间。修复:walk back 到 `is_char_boundary` 再 truncate
- channel ID 必须用 `"externalId":"UC..."` 严格匹配(我们 grep 抓 YouTube 频道页 HTML),`channel/UC...` 这种宽泛 regex 会抓到侧栏推荐频道

---

## 12. 已知问题 / 后续

- **Nikkei 频道**字幕覆盖率 0%(他们不上传字幕到 YouTube)。可以换成 NHK / 朝日 / 東洋経済 之类
- **PIVOT 频道**内容偏长(30-90 min),即便 60min 窗口也常常进入率低。考虑替换
- **Bilibili 没接入跟读控件**——`VideoPlayerHandle` 在 Bilibili 上是 no-op,postMessage 协议复杂,留作 V2
- **yt-dlp 升级风险**——YouTube 改反爬时 yt-dlp 通常 24-48h 内 patch,我们要跟着 update
- **多用户场景下 idiom 重复**——用户 A 和用户 B 各自导入同一条新闻,各自的 vocab 表都会有相同 8 个 idiom。不严重(单租户场景)
- **DeepSeek prompt 没做"重点单词"抽取**——idiom 是多词组合。如果要单字 vocab 推荐,需要扩 prompt 或加独立 LLM 调用
- **TTS 提供商**:从 ElevenLabs 切到 Azure Speech。ElevenLabs Free Tier 被反滥用系统封了(无关 credits),换 Azure F0 Tier(500K chars/月免费)。详见 README §5.13
- **质量评分上限实际只到 8**:模型没给过 9-10。要么放低锚点描述,要么接受 8 就是顶

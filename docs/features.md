# Listen Panel 功能手册

写给"未来的我"或新接手用的人。**怎么用、有什么快捷键、坑在哪里**。技术细节看 `README.md`,改起来怎么改看 `docs/maintaining.md`。

> 所有数据落本机 SQLite,所有 LLM/TTS key 落本机 JSON。除了主动外发(DeepSeek / Azure / YouTube / yt-dlp),没有任何遥测。

---

## 0. 一分钟上手

1. 启动:`./dev.sh`,浏览器开 http://localhost:19527/
2. 首次进入 `/setup` → 创建管理员账户
3. 进 `/settings` → 填 DeepSeek key、Azure Speech key + Region、(可选)远程 ASR worker
4. 书架 → "+ 新建"或选 `/news` 一键导入一条新闻
5. 在 Reader 里:**选词加词、点高亮查释义、点"翻译分析"出译文+语法**;右侧视频可循环跟读
6. 任意页面按 `⇧⌘J`(Win/Linux: `⇧⌃J`)记一句话

---

## 1. 账户与多用户

- 局域网内可多账户,登录后只看到自己的材料/生词/上传文件。HttpOnly cookie,session 默认 30 天。
- **首位账户自动成为 admin**。admin 才能改 LLM/TTS/ASR/数据目录、跑新闻抓取、备份导出。
- 忘记密码:目前没有 UI 重置,只能停服务直接改 SQLite 里的 `users.password_hash`(用 `cargo run --bin hash_password` 类似工具,或写小脚本调用 argon2id)。**不要删 users 行,否则连带 materials/vocab 级联消失**。

---

## 2. 书架 `/`

- 顶部 **英语 / 日语 tab**,带本语种条数计数。默认显示上次选择(`localStorage['listen-panel:library-lang']`)。
- 卡片网格:封面 / 标题 / 来源类型(local / youtube / bilibili)/ 更新时间。
- 想找旧材料但不记得在哪语言下:切两个 tab 各扫一眼。**没有跨语言搜索**(可加,目前还没做)。

---

## 3. 新建材料 `/new`

- 三种来源:`youtube` / `bilibili` / `local`。
- **粘 URL 自动识别**:粘 YouTube/Bilibili 链接到来源框,会防抖调后端 metadata 接口,自动切类型 + 回填标题。失败时回退手填,不阻塞保存。
- **本地视频**:支持 mp4 / mkv / webm / mov / m4v,上限 2 GiB。
  - 拖放区可拖文件进来,或点击触发文件选择器。
  - **挑/拖时只暂存**,点"保存"才真上传 → 防换文件 / 取消反复留孤儿。
  - 替换原文件:保存时旧 uuid 自动清掉(已做 ref-count 校验防误删)。
- 选择语言(`en` / `ja`)→ 影响后续 ASR 语言、查词 prompt、朗读 fallback。

---

## 4. Reader `/m/:id` — 主战场

### 4.1 布局
- 左原文 / 右视频,中间分隔条可拖(28-78% 区间)
- 顶栏:返回 / 标题 / 高亮开关 / 生词面板按钮 / 分栏比例 / 均分 / 编辑 / 翻译分析 / 跟读控件

### 4.2 选词加词
1. 在左栏选中词或短语(≤80 字),浮出 **"+ 加为生词"** 按钮
2. 点击 → 弹出"加生词"对话框 + DeepSeek 实时查上下文相关释义(原形 / 音标 / 词性 / 中英释义 / 例句)
3. 可改任何字段(必填中文释义)→ 保存。Reader 立即重拉本材料 vocab,高亮即生效

### 4.3 点击高亮查释义
- 已加的词在原文中以彩色高亮显示。点击 → 弹 popover 显示音标 / 词性 / 中英释义 / 原句中译。
- popover 用 React Portal 挂在 `body`,不被左栏 overflow 裁切;靠近视口边缘自动 clamp,下半屏自动往上弹。
- 关闭策略:再次点击 / 点别处 / 滚动文章 → 立刻关。
- **限制**:不做词形还原。存了 "running" 不会自动匹配 "ran"。日语同理,只匹配精确表记。

### 4.4 翻译分析
- ASR 完成后顶栏出现"**翻译分析**"按钮。**默认关闭,不烧 LLM**。点击后才生成:
  - 自然中文翻译(整段级)
  - 语法点(虚拟语气 / 时态 / 被动 / 非谓语 / 从句 / 情态等,只挑文本里真出现的)
  - 固定搭配 / phrasal verbs / 介词搭配
- 分段批量调用(每批 8 段 / 5000 字符上限),已完成批次先显示,长视频不必等全文。
- 失败可重试。某段超长导致 `EOF while parsing a list`?已把 `max_tokens` 调到 8192,基本不会再撞;实在撞上就把段落数缩短再试。

### 4.5 跟读控件(Shadowing)
- 速度档:`0.75 / 0.85 / 1 / 1.25 / 1.5×`
  - 0.75 / 0.85 → 慢练复读(YouTube 也支持,但只能取整到 0.75)
  - 1.25 / 1.5 → 已熟材料快听,信息密度榨干
- 句末停顿:`0 / 0.5 / 1 / 2 秒`(等自己跟完再播下一段)
- 每段时间戳右侧 **↻ 循环** 按钮:点了变 ● 循环中,反复回到 segment 起点直到停止
- YouTube 偶尔会把速度自动重置回 1×,再点一下 pill 即可(早期实现是 1 秒轮询防自重置,触发了浏览器卡死,**已改成只在切档时下发**)

### 4.6 段落↔视频时间同步(2026-05-23 起)
- 关闭页面 / 切走时,VideoPlayer 把当前播放时间存到 localStorage
- 下次进 Reader:**优先把左侧文章滚到对应 segment 所在的段落**,而不是只恢复 scrollTop。视频和文章对齐。
- 没有 segments 的纯文本材料回退旧的 scrollTop 恢复。

### 4.7 假名 toggle(日语)
- 日语材料 Reader 顶栏多一个 **「假名」** toggle(localStorage 记忆默认开)
- 开启时:文章里非常用 kanji(N3 以上)上方显示 ruby 假名标注。来自后端 LLM 服务端预生成(导入 JP 材料时异步跑,5 段一批),严格 HTML sanitize 只放行 `<ruby>` / `<rt>`。
- 关闭时:纯汉字显示。
- 老的 JP 材料没标过?admin 跑一次 `POST /api/news/_backfill_furigana`(curl 用 admin cookie),后台跑完就有。

### 4.8 生词朗读
- 词卡 / 抽屉 / 复习卡都有 🔈 朗读按钮。Provider 链:
  1. Azure Speech(`en-US-AriaNeural` / `ja-JP-NanamiNeural`,免费 500K chars/月)
  2. Free Dictionary mp3(仅英语)
  3. 浏览器 `speechSynthesis`(系统声音,质量不稳)
- 已生成的音频会按 `(provider, voice, text, lang)` hash 落盘 `tts-cache/`,二次朗读零延迟。换 voice 自动失效。

---

## 5. News `/news/en` 和 `/news/ja`

- 每 3 小时自动抓 8 个频道(英 4 + 日 4)的最近上传,DeepSeek 自动给:
  - 话题(财经 / 政治 / 科技 / 文化 / 其他)
  - 难度 1-5
  - **质量评分 1-10**(NYT Daily / NHK 解説 = 9-10,WSJ explainer = 7-8,vlog = 1-4)
  - **质量评语**(显示在卡片底部,看分数怎么打出来的)
  - 8 条 idiom / 固定表达 + 中文释义
- 列表默认过滤 `quality >= 7`(NULL 也透传,backfill 后才严格生效)
- 顶部 pill 筛选:来源 / 话题 / 时长(`<10min / 10-30min / >30min`)
- 点 **"加入书架并跟读"** → 一次导入(材料 + 段落 + idiom 落 vocab)→ 直接跳 Reader

### 设置 YouTube 抓取
1. 装 `yt-dlp`:`brew install yt-dlp` 或 `pip install -U yt-dlp`(YouTube 反爬天天变,版本要新)
2. `.env` 里填 `YOUTUBE_API_KEY=AIza...`(Google Cloud Console → 启用 YouTube Data API v3 → 创建 API 密钥)
3. 重启服务,启动 45s 后第一次抓取,然后每 3h 一轮
4. 想立即拉一次:admin 跑 `POST /api/news/_refresh`

### 想换频道?
改 `backend/src/news_fetcher.rs::CHANNELS` 常量数组,重启即可。详细选择标准、Channel ID 查法见 `docs/news-shadowing.md`。

---

## 6. 随手记 `/quick-notes`

> "在 IM/文章/视频弹幕看到一句话想存,先放着,稍后再消化"

- **触发**:
  - 左下角浮按钮 "✏ 随手记"(全页可见,Reader 全屏也在)
  - 全局快捷键 **`⇧⌘J`**(macOS)/ **`⇧⌃J`**(Win-Linux)
- **流程**:
  1. 粘原句 + 选语言(EN / JA)+ 可选填出处(URL 或备注)
  2. 提交 → 后端跑 DeepSeek(2-5 秒)→ 弹出翻译 / 重点表达 / 语法点
  3. 不满意可点"编辑"逐项改:翻译可改、表达和语法可增删行,空行会自动清掉
  4. "再记一条"清空回输入态;关掉对话框已自动落库,下次在 `/quick-notes` 看
- **列表页 `/quick-notes`**:
  - 顶部 tab:全部 / EN / 日本語
  - 搜索框:对 text + translation 模糊匹配
  - 卡片默认折叠两行 → 点"展开"看全;每张可删
- 上限 500 条,按创建时间倒序。
- **跟生词本的区别**:生词本绑材料,要先看视频才会有;随手记是 app 外的临时备忘册,不绑材料、永久保留。

---

## 7. 复习 `/review`

- 选范围:全部 vocab / 单一材料;勾不勾 mastery=3
- Fisher-Yates 洗牌后逐张
- 正面:词 + 音标 + cloze 上下文(目标词遮成同色色块)
- 翻面:词性 + 中英释义 + 原句中译
- 三档手判:`不记得 (0) / 模糊 (不变) / 记得 (+1, 封顶 3)`
- 没 SRS 算法。简单可控,目前没痛点不打算加。

---

## 8. 笔记 `/notes`

- 段落 / segment 级笔记,绑材料。
- Reader 里在文本上挂笔记;`/notes` 页是跨材料的笔记索引。
- 这一块用得少,详见 `pages/Notes.tsx`,先不展开。

---

## 9. 数据备份与恢复

### 导出
- Settings 页底部 → **「导出备份 (.tar.gz)」**(admin only)
- 一键下载 `listen-panel-backup-YYYYMMDD-HHMMSS.tar.gz`,**流式打包**(几个 GB 也不吃内存)
- 内含:
  - `app.db`(SQLite `VACUUM INTO` 一致性快照,**安全在跑也能导**)
  - `uploads/`(本地上传的视频)
  - `tts-cache/`(已生成的朗读音频,避免恢复后重烧 quota)
  - `config.json` / `tts.json` / `asr.json`,**所有 `api_key` / `token` / `secret` 字段值改写成 `"***"`**

### 恢复
1. 停服务
2. 解压 tarball 到新机器的数据目录
3. 重新填 `config.json` / `tts.json` / `asr.json` 里被脱敏的 key
4. 启动 → 数据继续

### 自动定时备份?
现在没做。可以在 cron 里 `curl http://localhost:9527/api/settings/backup -H 'Cookie: listen_panel_session=<admin>' -o backup.tar.gz`。

---

## 10. 设置 `/settings`

| 区块 | 字段 | 备注 |
|---|---|---|
| **DeepSeek** | API key / Base URL / Model | Base URL 用于兼容 OpenAI 协议的代理;Model 默认 `deepseek-chat`。留空 key 不覆盖 |
| **Azure Speech TTS** | Subscription key / Region / 英语 voice / 日语 voice / 输出格式 | Region 跟 Azure portal 资源 Location 字段一致(如 `eastus`);voice gallery: https://speech.microsoft.com/portal/voicegallery |
| **远程 ASR Worker** | Worker base URL / Shared token / Backend base URL / 模型 / 语言 / Beam / VAD / 超时 / 高精度 | 配合 `asr-worker/`;局域网/公网/隧道地址都能用,健康检查可探活 |
| **播放** | 本地视频默认音量 | 仅本地 mp4 生效。YouTube/Bilibili 不能管(走它们自己控件) |
| **数据存储** | 数据目录 | admin 可见;改后写 `data-dir.json`,**重启生效**。环境变量 `LISTEN_PANEL_DATA_DIR` 优先级最高 |
| **数据导出** | 「导出备份 (.tar.gz)」 | admin only |

**Key 落 JSON,不入数据库,永不回传前端。** 状态徽标只显示"已配置 / 未配置"。

---

## 11. 快捷键总览

| 快捷键 | 在哪 | 作用 |
|---|---|---|
| `⇧⌘J` / `⇧⌃J` | 任意页面 | 打开随手记 |
| `Esc` | 弹窗 | 关闭(标准浏览器行为) |
| 鼠标拖左右分隔条 | Reader | 改左右栏比例 |
| 选中文字 | Reader 左栏 | 浮出"+ 加为生词" |
| 点击高亮 | Reader 左栏 | 显示释义 popover |
| 滚动 | Reader 左栏 | 自动保存 scrollTop 给下次恢复 |

---

## 12. 常见坑

| 现象 | 原因 / 解决 |
|---|---|
| 新闻页空 | YOUTUBE_API_KEY 没设 / yt-dlp 没装 / 还没到 45s 启动延迟 |
| JP 视频没有假名标注 | 材料是 furigana 功能上线前导入的 → admin 跑 `POST /api/news/_backfill_furigana` |
| `翻译分析` 失败 EOF | 某段过长撞 max_tokens → 现已调到 8192,基本无;实在又撞,缩短段落 |
| TTS 一直转浏览器声音 | Azure key 没填 / 配额耗尽(F0 = 500K chars/月)/ region 拼错(看 portal 显示的 Location) |
| 速度档点不动 | YouTube iframe 还在 buffering,等一秒再试 |
| 文章和视频对不上 | 用的是旧版无 segments 的材料 → 等 ASR 跑完会出 segments 后再恢复就对齐了 |
| 备份解压后 key 都是 `***` | 故意脱敏防泄密 → 解压后手动重填这几个字段 |
| 忘记密码 | 直接改 SQLite `users.password_hash`(argon2id PHC 字符串),**不要删行** |

---

## 13. 不会做 / 没打算做的事

- 自动 SRS 复习算法(三档手判够用)
- 跨语言书架搜索(切 tab 各扫一遍即可)
- 词形还原 / 分词点击(英语和日语都没做;V1 精确表记匹配)
- 整段 TTS / AB 循环 SRT(V2 规划)
- 单二进制部署(规划中,需把 frontend dist 由 Axum 兼托管)

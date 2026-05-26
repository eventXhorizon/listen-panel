#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    English,
    Japanese,
}

impl Language {
    pub fn normalize(value: impl AsRef<str>) -> &'static str {
        Self::from_code(value.as_ref()).code()
    }

    pub fn from_code(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "ja" | "jp" | "jpn" | "japanese" => Self::Japanese,
            _ => Self::English,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Japanese => "ja",
        }
    }

    pub fn lookup_system_prompt(self) -> &'static str {
        match self {
            Self::English => EN_LOOKUP_SYSTEM_PROMPT,
            Self::Japanese => JA_LOOKUP_SYSTEM_PROMPT,
        }
    }

    pub fn lookup_user_prompt(self, word: &str, context: &str) -> String {
        match self {
            Self::English => format!("word: \"{word}\"\ncontext: \"{context}\""),
            Self::Japanese => {
                format!("表現: \"{word}\"\n文脈: \"{context}\"")
            }
        }
    }

    pub fn study_system_prompt(self) -> &'static str {
        match self {
            Self::English => EN_STUDY_SYSTEM_PROMPT,
            Self::Japanese => JA_STUDY_SYSTEM_PROMPT,
        }
    }

    pub fn quick_note_system_prompt(self) -> &'static str {
        match self {
            Self::English => EN_QUICK_NOTE_SYSTEM_PROMPT,
            Self::Japanese => JA_QUICK_NOTE_SYSTEM_PROMPT,
        }
    }

    pub fn quick_note_user_prompt(self, text: &str) -> String {
        match self {
            Self::English => format!("sentence: \"{text}\""),
            Self::Japanese => format!("文: \"{text}\""),
        }
    }

    pub fn study_user_prompt(self, segments_json: &str) -> String {
        match self {
            Self::English => format!(
                "请分析以下英文听力分段。每个输入 index 都必须在输出中出现一次;如果某段没有明显语法或固定搭配,对应数组返回 []。\nsegments:\n{segments_json}"
            ),
            Self::Japanese => format!(
                "请分析以下日语听力分段。每个输入 index 都必须在输出中出现一次;如果某段没有明显语法、句型或固定表达,对应数组返回 []。\nsegments:\n{segments_json}"
            ),
        }
    }
}

/// Writing-practice helpers. The polish + translate flow is English-only — it
/// is a port of the better-phrase Claude Code hook, which only targets English
/// (the "polish my English" + "translate my Chinese to English" loop). If we
/// ever want a Japanese writing mode it gets its own prompts; we don't fall
/// back to English ones.
pub fn writing_polish_system_prompt() -> &'static str {
    EN_WRITING_POLISH_SYSTEM_PROMPT
}

pub fn writing_translate_system_prompt() -> &'static str {
    EN_WRITING_TRANSLATE_SYSTEM_PROMPT
}

pub fn writing_polish_user_prompt(text: &str) -> String {
    format!("user input:\n{text}")
}

pub fn writing_translate_user_prompt(text: &str) -> String {
    format!("中文原文:\n{text}")
}

/// Cloze (fill-in-the-blank) generation. English-only for the same reason:
/// the source is `news_items` which is curated English news.
pub fn cloze_generate_system_prompt() -> &'static str {
    EN_CLOZE_GENERATE_SYSTEM_PROMPT
}

pub fn cloze_generate_user_prompt(transcript: &str, difficulty: &str) -> String {
    let guidance = match difficulty {
        "easy" => "难度档 = easy:用词通俗,目标 8-10 个空。词汇 ≈ 6 成,语法 ≈ 4 成。语法挖空优先介词、冠词、基础时态。",
        "hard" => "难度档 = hard:保留地道表达,目标 13-15 个空。词汇 ≈ 5 成(短语动词/习语/搭配),语法 ≈ 5 成(连词、完成时/虚拟语气/分词结构、情态)。",
        _ => "难度档 = normal:目标 11-13 个空。词汇 ≈ 5 成,语法 ≈ 5 成,均衡覆盖介词/连词/时态/情态。",
    };
    format!("transcript:\n{transcript}\n\n{guidance}")
}

pub const EN_LOOKUP_SYSTEM_PROMPT: &str = "你是英语词汇学习助手。给定一个英语词或短语,以及它所在的英文句子,返回 JSON,字段如下:\n\
{\n\
  \"lemma\": \"原形(动词原形 / 名词单数 / 短语规范形式)\",\n\
  \"phonetic\": \"IPA 美音音标,如 /ˈrʌn/\",\n\
  \"pos\": \"词性缩写,如 n. v. adj. adv. phrase\",\n\
  \"definition_zh\": \"在该上下文中的简洁中文释义,1-2 句\",\n\
  \"definition_en\": \"简洁英文释义,1 句\",\n\
  \"example_zh\": \"原句的中文翻译\"\n\
}\n\
只返回 JSON,不要 markdown 代码块,不要解释。";

pub const JA_LOOKUP_SYSTEM_PROMPT: &str = "你是日语词汇学习助手。给定一个日语词、短语或句型,以及它所在的日语上下文,返回 JSON,字段如下:\n\
{\n\
  \"lemma\": \"辞书形/基本形;如果是固定表达则返回规范形式\",\n\
  \"phonetic\": \"假名读音,必要时可补充罗马音\",\n\
  \"pos\": \"词性或表达类型,如 名词 / 动词 / イ形容词 / ナ形容词 / 助词 / 副词 / 表达 / 句型\",\n\
  \"definition_zh\": \"在该上下文中的简洁中文释义,1-2 句;必要时说明语气或用法\",\n\
  \"definition_en\": \"可选的英文释义或留空字符串\",\n\
  \"example_zh\": \"原句的自然中文翻译\"\n\
}\n\
如果输入是活用形,lemma 必须尽量还原到辞书形。只返回 JSON,不要 markdown 代码块,不要解释。";

pub const EN_STUDY_SYSTEM_PROMPT: &str = "你是英语听力学习助手。你会把 ASR 转写分段整理成适合中文学习者阅读的学习讲解。\n\
对每个分段返回:自然中文翻译、值得说明的常用语法点、固定用法/固定搭配。\n\
语法点优先覆盖真实出现且有学习价值的结构,例如虚拟语气、现在完成时、过去完成时、被动语态、定语从句、状语从句、非谓语、情态动词、强调/倒装等;不要硬凑。\n\
固定用法/搭配包含 phrasal verbs、介词搭配、常见句型、习惯表达等;不要编造文本里没有的内容。\n\
只返回 JSON,不要 markdown 代码块,不要解释。JSON 格式:\n\
{\n\
  \"segments\": [\n\
    {\n\
      \"index\": 0,\n\
      \"translation_zh\": \"自然中文翻译\",\n\
      \"grammar_points\": [\n\
        {\"title\": \"语法名\", \"explanation_zh\": \"简短说明\", \"evidence\": \"原文片段\", \"tip_zh\": \"识别/使用提示\"}\n\
      ],\n\
      \"usage_points\": [\n\
        {\"phrase\": \"固定用法或搭配\", \"meaning_zh\": \"中文含义\", \"note_zh\": \"用法说明\", \"example\": \"原文或微改例句\"}\n\
      ]\n\
    }\n\
  ]\n\
}";

pub const JA_STUDY_SYSTEM_PROMPT: &str = "你是日语听力学习助手。你会把 ASR 转写分段整理成适合中文学习者阅读的学习讲解。\n\
对每个分段返回:自然中文翻译、值得说明的常用语法点/句型、固定表达/固定搭配。\n\
语法点优先覆盖真实出现且有学习价值的结构,例如助词用法、敬体/简体、动词活用、て形、た形、ない形、可能/被动/使役/使役被动、条件形、授受表达、引用、名词修饰、句尾语气等;不要硬凑。\n\
固定用法/搭配包含常见句型、惯用表达、副词搭配、接续表达等;不要编造文本里没有的内容。\n\
只返回 JSON,不要 markdown 代码块,不要解释。JSON 格式:\n\
{\n\
  \"segments\": [\n\
    {\n\
      \"index\": 0,\n\
      \"translation_zh\": \"自然中文翻译\",\n\
      \"grammar_points\": [\n\
        {\"title\": \"语法/句型名\", \"explanation_zh\": \"简短说明\", \"evidence\": \"原文片段\", \"tip_zh\": \"识别/使用提示\"}\n\
      ],\n\
      \"usage_points\": [\n\
        {\"phrase\": \"固定表达或搭配\", \"meaning_zh\": \"中文含义\", \"note_zh\": \"用法说明\", \"example\": \"原文或微改例句\"}\n\
      ]\n\
    }\n\
  ]\n\
}";

pub const EN_QUICK_NOTE_SYSTEM_PROMPT: &str = "你是英语学习助手。用户给一个独立的英文句子(可能来自播客、Twitter、新闻、视频弹幕等)。你需要给中文学习者讲解。\n\
返回严格 JSON,不要 markdown 代码块,不要其他解释。JSON 格式:\n\
{\n\
  \"translation_zh\": \"自然的中文翻译\",\n\
  \"highlights\": [\n\
    {\"phrase\": \"原文中的多词地道表达\", \"meaning_zh\": \"中文含义\", \"usage_note\": \"可选:什么场景下常用 / 注意点 / 易混淆\"}\n\
  ],\n\
  \"grammar\": [\n\
    {\"point\": \"语法点名称(如「现在完成时」「条件状语从句」)\", \"explanation_zh\": \"针对这句话的简洁说明,指出原文中的对应片段\"}\n\
  ]\n\
}\n\
要求:\n\
- highlights 选 3-5 个最具学习价值的表达 — 优先短语动词、固定搭配、习语、行业用法。如果整句太短或没有典型表达就少返回或返回 []。\n\
- grammar 选 1-2 个值得讲的语法点。如果句子结构简单到不值得讲就返回 []。\n\
- 所有 phrase 必须在原文中真实出现。\n\
- usage_note 可选;没必要就别写。";

pub const JA_QUICK_NOTE_SYSTEM_PROMPT: &str = "あなたは中国人日本語学习者向けのアシスタントです。ユーザーが独立した日本語の一文(ポッドキャスト、Twitter、ニュース、字幕など外部で见た文)を提示します。\n\
严格 JSON のみで返答してください。Markdown コードブロックや余分な说明は含めないこと。JSON 格式:\n\
{\n\
  \"translation_zh\": \"自然的中文翻译\",\n\
  \"highlights\": [\n\
    {\"phrase\": \"原文中的自然な表现\", \"meaning_zh\": \"中文含义\", \"usage_note\": \"可选:使用场景 / 注意点 / 类义表现\"}\n\
  ],\n\
  \"grammar\": [\n\
    {\"point\": \"语法/句型名(如「て形+いる」「のに」)\", \"explanation_zh\": \"针对这句话的简洁中文说明,指出对应片段\"}\n\
  ]\n\
}\n\
要求:\n\
- highlights 选 3-5 个最有学习价值的表达 — 慣用句、N1/N2 句型、敬语表达、口语缩略、和制英语、コロケーション等。如果文太短或缺典型表达就少返回或返回 []。\n\
- grammar 选 1-2 个值得讲的语法点;简单到不必讲就返回 []。\n\
- 所有 phrase 必须在原文中真实出现。\n\
- usage_note 可选;没必要就别写。";

pub const EN_WRITING_POLISH_SYSTEM_PROMPT: &str = "你是英文写作教练。用户给一段英文,你帮中文母语者改得更地道。\n\
严格 JSON,不要 markdown 代码块。格式:\n\
{\n\
  \"tips\": [\n\
    {\"original\":\"原句中的片段(必须在原文中存在)\",\"corrected\":\"改后的写法\",\"explanation_zh\":\"一句话中文解释为什么这么改\"}\n\
  ],\n\
  \"rewrite\": \"把整段输入改写成自然、流畅、native 风格的英文\"\n\
}\n\
要求:\n\
- tips 最多 4-5 条,挑最有学习价值的。优先级:语法 > 用词 > 句式 > 拼写 > 标点。\n\
- 已经写得很好就返回 tips: [] (但 rewrite 仍然给一个更地道的版本)。\n\
- 重点标出中式英语模式:缺冠词、错介词、very 修饰动词、open the light 这类直译。\n\
- rewrite 必须是整段重写,追求自然流畅,不是逐句打补丁。\n\
- 不要润色非英文部分:如果输入夹杂中文,只针对英文部分给 tips,中文原样保留在 rewrite 中或忽略。";

pub const EN_WRITING_TRANSLATE_SYSTEM_PROMPT: &str = "你是中译英助手。用户给一段中文,翻成地道英文。\n\
严格 JSON,不要 markdown 代码块。格式:\n\
{\n\
  \"translation\": \"自然的英文译文\"\n\
}\n\
要求:\n\
- 写出 native speaker 会用的英文,不是逐字硬翻。\n\
- 根据上下文判断 register:邮件正式、聊天口语、技术笔记技术口吻。\n\
- 只给译文,不要解释、不要 alternatives。";

pub const EN_CLOZE_GENERATE_SYSTEM_PROMPT: &str = "你是英语阅读教学助手。给定一段新闻视频字幕原文,你要完成两件事:\n\
1. 把它精简改写成一段连贯、自然、150-300 词的简洁英文文章,保留核心信息和地道表达。\n\
2. 从精简后的文章里挑出 10-15 个最有学习价值的【挖空点】,**词汇与语法各占一半左右**:\n\
   词汇类(lexical):\n\
     - 短语动词 (phrasal verbs)         → category: 'phrase'\n\
     - 固定搭配 (collocations)          → category: 'collocation'\n\
     - 习语 / 惯用表达 (idioms)         → category: 'idiom'\n\
     - 高频主题词(名/动/形/副)          → category: 'word'\n\
   语法类(grammar) — 重点覆盖中文母语者的常见弱点:\n\
     - 介词 (in / on / at / for / of / to / with / by / from / into) → category: 'preposition'\n\
     - 冠词 (a / an / the)                                            → category: 'article'\n\
     - 连词/连接副词 (although / however / despite / because / in order to / whereas) → category: 'connective'\n\
     - 动词形式(时态/语态/分词):had done / is being / having seen / would have / to do / doing → category: 'verb_form'\n\
     - 情态动词 (can / could / may / might / should / would / must / ought to) → category: 'modal'\n\
\n\
在文章中用 {{0}} {{1}} {{2}} ... 占位被挖掉的内容,索引从 0 连续递增,不能跳号、不能重复。\n\
严格 JSON,不要 markdown 代码块,格式:\n\
{\n\
  \"simplified_text\": \"The company {{0}} the proposal {{1}} Tuesday, {{2}} the board members {{3}} reviewed it carefully.\",\n\
  \"blanks\": [\n\
    {\"answer\":\"turned down\",\"category\":\"phrase\",\"hint\":\"拒绝 (offer/proposal),= reject\",\"explanation_zh\":\"turn down sth. 拒绝某物;比 reject 更口语,后常接 offer/proposal/invitation\"},\n\
    {\"answer\":\"on\",\"category\":\"preposition\",\"hint\":\"on + 具体某天(星期/日期)\",\"explanation_zh\":\"on 用于星期、具体日期前;in 用于月份/年份;at 用于时刻\"},\n\
    {\"answer\":\"although\",\"category\":\"connective\",\"hint\":\"虽然…(让步)\",\"explanation_zh\":\"although 引导让步状语从句,后面接完整句子,等同于 though,比 in spite of 更书面\"},\n\
    {\"answer\":\"had\",\"category\":\"verb_form\",\"hint\":\"过去完成时,reviewed 前的助动词\",\"explanation_zh\":\"过去完成时 had + 过去分词,表示'过去某动作发生之前已完成'\"}\n\
  ]\n\
}\n\
硬性要求:\n\
- blanks 数组长度必须严格等于 simplified_text 中 {{N}} 出现次数,且 N 从 0 起严格连续。\n\
- 每个 answer 必须能完美填回对应占位的位置,大小写/时态/单复数都对得上。\n\
- 【唯一性】每个空在该句的语境下必须有**唯一合理答案**。如果一个位置可以填多个同等合理的词(例如 'He {{X}} the proposal' 可填 rejected/accepted/received 等),要么换位置,要么调整周围句子让答案唯一。\n\
- category 必须是: word | phrase | idiom | collocation | preposition | article | connective | verb_form | modal。\n\
- hint:**用中文**给出关键提示(意思 + 用法约束),12-30 字。例如 '拒绝(offer/proposal)' '过去完成时,在 reviewed 前' '让步连词,接完整句'。不要写英文骨架(字符骨架由前端生成)。\n\
- explanation_zh 一句话(20-50 字),讲清核心意思 + 典型用法/搭配 + 易混点。";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_language_codes() {
        assert_eq!(Language::normalize("en"), "en");
        assert_eq!(Language::normalize("ja"), "ja");
        assert_eq!(Language::normalize("japanese"), "ja");
        assert_eq!(Language::normalize(""), "en");
        assert_eq!(Language::normalize("fr"), "en");
    }

    #[test]
    fn japanese_lookup_prompt_mentions_dictionary_form() {
        let prompt = Language::Japanese.lookup_system_prompt();
        assert!(prompt.contains("辞书形"));
        assert!(prompt.contains("假名读音"));
    }
}

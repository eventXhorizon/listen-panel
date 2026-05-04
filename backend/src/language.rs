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

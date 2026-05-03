use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Material {
    pub id: i64,
    pub user_id: i64,
    pub title: String,
    pub source_type: String,
    pub source_ref: String,
    pub text: String,
    pub notes: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateMaterial {
    pub title: String,
    pub source_type: String,
    pub source_ref: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMaterial {
    pub title: Option<String>,
    pub source_type: Option<String>,
    pub source_ref: Option<String>,
    pub text: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Vocab {
    pub id: i64,
    pub material_id: i64,
    pub word: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub pos: Option<String>,
    pub definition_zh: String,
    pub definition_en: Option<String>,
    pub example_zh: Option<String>,
    pub context: String,
    pub mastery: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateVocab {
    pub material_id: i64,
    pub word: String,
    pub lemma: String,
    #[serde(default)]
    pub phonetic: Option<String>,
    #[serde(default)]
    pub pos: Option<String>,
    pub definition_zh: String,
    #[serde(default)]
    pub definition_en: Option<String>,
    #[serde(default)]
    pub example_zh: Option<String>,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub mastery: i64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVocab {
    pub word: Option<String>,
    pub lemma: Option<String>,
    pub phonetic: Option<String>,
    pub pos: Option<String>,
    pub definition_zh: Option<String>,
    pub definition_en: Option<String>,
    pub example_zh: Option<String>,
    pub context: Option<String>,
    pub mastery: Option<i64>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct TranscriptionJob {
    pub id: i64,
    pub user_id: i64,
    pub material_id: i64,
    pub provider: String,
    pub model: String,
    pub language: String,
    pub status: String,
    pub progress: i64,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct TranscriptSegment {
    pub id: i64,
    pub job_id: i64,
    pub material_id: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

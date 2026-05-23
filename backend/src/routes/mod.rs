pub mod asr;
pub mod auth;
pub mod backup;
pub mod health;
pub mod llm;
pub mod materials;
pub mod media;
pub mod news;
pub mod notes;
pub mod quick_notes;
pub mod settings;
pub mod tts;
pub mod vocab;

use axum::Router;

pub fn api_router(state: crate::AppState) -> Router {
    Router::new()
        .merge(materials::router())
        .merge(auth::router())
        .merge(asr::router())
        .merge(vocab::router())
        .merge(notes::router())
        .merge(media::router())
        .merge(llm::router())
        .merge(tts::router())
        .merge(settings::router())
        .merge(backup::router())
        .merge(news::router())
        .merge(quick_notes::router())
        .with_state(state)
}

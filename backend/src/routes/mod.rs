pub mod llm;
pub mod materials;
pub mod media;
pub mod settings;
pub mod tts;
pub mod vocab;

use axum::Router;

pub fn api_router(state: crate::AppState) -> Router {
    Router::new()
        .merge(materials::router())
        .merge(vocab::router())
        .merge(media::router())
        .merge(llm::router())
        .merge(tts::router())
        .merge(settings::router())
        .with_state(state)
}

# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the listen-panel Rust backend.
# Build context is the `backend/` directory (set in CI and docker-compose).
#
# Migrations are embedded into the binary at compile time via `sqlx::migrate!()`,
# so the runtime stage does not need to ship the migrations/ directory.

# ---------- build stage ----------
FROM rust:1.90-bookworm AS builder
WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release && \
    cp target/release/backend /backend

# ---------- runtime stage ----------
FROM debian:bookworm-slim AS runtime

# yt-dlp standalone Linux binary (PyInstaller bundle, no Python needed).
# Pin the version so deployments are reproducible; bump intentionally when needed.
ARG YT_DLP_VERSION=2025.09.05

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl tini && \
    rm -rf /var/lib/apt/lists/* && \
    curl -fL -o /usr/local/bin/yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux" && \
    chmod +x /usr/local/bin/yt-dlp && \
    yt-dlp --version

WORKDIR /app
COPY --from=builder /backend /usr/local/bin/backend

ENV LISTEN_PANEL_DATA_DIR=/data \
    RUST_LOG=info

VOLUME ["/data"]
EXPOSE 9527

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:9527/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["backend"]

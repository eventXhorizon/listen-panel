# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the listen-panel frontend.
# Build context is the `frontend/` directory (set in CI and docker-compose).
# The runtime nginx config proxies /api and /health to the backend service.

# ---------- build stage ----------
FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=optional

COPY . .
RUN npm run build

# ---------- runtime stage ----------
FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /build/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost/ > /dev/null || exit 1

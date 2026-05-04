# GPU Compute Platform Roadmap

## Goal

Build the GPU machine into a reusable compute service instead of exposing one ASR-specific worker. ASR is the first workload; future workloads such as TTS, OCR, embeddings, video analysis, and local LLM inference should share the same gateway, job lifecycle, authentication, storage, logging, and progress model.

## Target Architecture

```text
Public / private clients
  -> HTTPS / VPN / tunnel
  -> GPU Gateway
  -> Job Store + Queue
  -> GPU Worker Runtime
  -> Artifact Storage
```

- **GPU Gateway**: the only public-facing API. It authenticates requests, creates jobs, returns status, exposes result metadata, and applies concurrency and size limits.
- **Job Store + Queue**: records job state and provides durable scheduling. V1 can be in-memory; later versions should move to SQLite/Postgres plus Redis/NATS when multiple worker processes or machines are needed.
- **GPU Worker Runtime**: executes task handlers such as `asr.transcribe` and `tts.synthesize`. Workers advertise capabilities and never need to be exposed directly to the public internet.
- **Artifact Storage**: stores input files, output files, transcripts, generated audio, logs, and model cache separately from service code. V1 can use local directories; later versions can use MinIO/S3.

## Public Access Model

Recommended order:

1. **Tailscale/WireGuard** for personal use. This avoids direct public exposure and is the safest default.
2. **Cloudflare Tunnel + Access** when browser/API access from outside the LAN is needed without opening inbound ports.
3. **HTTPS reverse proxy** with Caddy/Nginx only if direct public exposure is required. Public endpoints must use API tokens, request size limits, rate limits, and worker isolation.

Workers should stay behind the gateway in all cases.

## Unified Job API

Create jobs:

```http
POST /v1/jobs
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "type": "asr.transcribe",
  "input": {
    "source_type": "local",
    "source_ref": "video.mp4",
    "media_url": "http://listen-panel:9527/api/asr/media/1",
    "media_token": "..."
  },
  "options": {
    "model": "large-v3",
    "language": "en",
    "beam_size": 5,
    "vad_filter": true,
    "condition_on_previous_text": false
  },
  "callback": {
    "progress_url": "http://listen-panel:9527/api/asr/progress/1",
    "progress_token": "..."
  }
}
```

Status:

```http
GET /v1/jobs/{job_id}
```

Result:

```http
GET /v1/jobs/{job_id}/result
```

Common job states:

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

Common job fields:

- `id`
- `type`
- `status`
- `progress`
- `stage`
- `error`
- `created_at`
- `started_at`
- `completed_at`

## Workload Types

### ASR: `asr.transcribe`

First supported workload. It wraps the current faster-whisper pipeline:

- local media via `media_url`
- YouTube/Bilibili via `yt-dlp`
- subtitle-first strategy
- fallback to faster-whisper
- progress callback compatible with listen-panel

### TTS: `tts.synthesize`

Future workload. Expected input:

```json
{
  "type": "tts.synthesize",
  "input": {
    "text": "Hello world"
  },
  "options": {
    "voice": "female_01",
    "format": "mp3"
  }
}
```

Result should include an artifact URL or artifact id for generated audio.

### Future Workloads

- `ocr.extract`
- `embedding.generate`
- `llm.generate`
- `video.summarize`
- `vision.describe`

## Version Plan

### V1.0: Single-Process Gateway Worker

Scope:

- Keep the current `asr-worker/worker.py` deployment model.
- Add a generic `/v1/jobs` API.
- Keep `/v1/transcribe` for backwards compatibility.
- Execute one GPU job at a time with an in-process queue.
- Store job state in memory only.
- Add `GET /v1/capabilities`, `GET /v1/jobs/{id}`, and `GET /v1/jobs/{id}/result`.

Non-goals:

- Public hardening beyond bearer token support.
- Durable queue after process restart.
- Multiple machines.
- TTS implementation.

### V1.1: listen-panel Uses Generic Jobs

Scope:

- Add a backend ASR option that creates `asr.transcribe` jobs through `/v1/jobs`.
- Poll the GPU gateway job until it completes.
- Keep the old `/v1/transcribe` path as fallback.

### V1.2: Durable Local Runtime

Scope:

- Persist jobs to SQLite.
- Persist inputs/outputs/logs under a configurable `GPU_DATA_DIR`.
- Add result artifact metadata.
- Add cancellation endpoint.

### V2.0: Public Gateway

Scope:

- Deploy behind HTTPS, Tailscale, or Cloudflare Tunnel.
- Add API token scopes.
- Add request body/file size limits.
- Add rate limiting.
- Add structured access logs.

### V2.1: TTS Workload

Scope:

- Add `tts.synthesize` handler.
- Support one local TTS model first.
- Store generated audio as artifacts.
- Add model/voice capability reporting.

### V3.0: Multi-Worker Runtime

Scope:

- Split gateway and workers.
- Use Redis/NATS/RabbitMQ for queueing.
- Workers register capabilities and heartbeat.
- Route jobs by capability, model, and GPU memory.

## Operational Rules

- Do not expose raw worker handlers directly to the internet.
- Use one gateway token or API key at minimum.
- Log job id, task type, stage, progress, elapsed time, and failures.
- Never log bearer tokens, callback tokens, or full private input payloads.
- Keep model cache separate from temporary job files.
- Clean temporary inputs by default; keep them only when explicitly configured.

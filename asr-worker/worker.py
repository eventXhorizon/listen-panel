from __future__ import annotations

import html
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field


load_dotenv()

HOST = os.getenv("ASR_HOST", "0.0.0.0")
PORT = int(os.getenv("ASR_PORT", "8765"))
SHARED_TOKEN = os.getenv("ASR_TOKEN", "").strip()
DEFAULT_MODEL = os.getenv("ASR_MODEL", "large-v3")
DEVICE = os.getenv("ASR_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("ASR_COMPUTE_TYPE", "float16")
DOWNLOAD_DIR = Path(os.getenv("GPU_DATA_DIR", os.getenv("ASR_DOWNLOAD_DIR", "./data")))
KEEP_MEDIA = os.getenv("ASR_KEEP_MEDIA", "0") == "1"
LOG_LEVEL = os.getenv("ASR_LOG_LEVEL", "INFO").upper()
MAX_JOBS = int(os.getenv("GPU_MAX_JOBS", "100"))

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s [asr-worker] %(message)s",
)
logger = logging.getLogger("asr-worker")

app = FastAPI(title="Listen Panel GPU Worker")
_model_cache: dict[str, WhisperModel] = {}
_jobs: dict[str, "JobRecord"] = {}
_jobs_lock = threading.Lock()
_job_queue: queue.Queue[str] = queue.Queue()
_job_worker_started = False
_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_BILIBILI_BVID = re.compile(r"^BV[A-Za-z0-9]+$")
_VTT_TIMESTAMP_TAG = re.compile(r"<\d{2}:\d{2}:\d{2}\.\d{3}>")
_HTML_TAG = re.compile(r"</?[^>]+>")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class JobRecord:
    id: str
    job_type: str
    request: "CreateJobRequest"
    status: str = "queued"
    progress: int = 0
    stage: str = "queued"
    error: str | None = None
    result: dict[str, Any] | None = None
    created_at: str = field(default_factory=utc_now)
    started_at: str | None = None
    completed_at: str | None = None


class TranscribeRequest(BaseModel):
    job_id: int | str
    source_type: str
    source_ref: str
    media_url: str | None = None
    media_token: str | None = None
    model: str = DEFAULT_MODEL
    language: str = "en"
    beam_size: int = Field(default=5, ge=1, le=10)
    vad_filter: bool = True
    condition_on_previous_text: bool = False
    progress_url: str | None = None
    progress_token: str | None = None


class Segment(BaseModel):
    start: float
    end: float
    text: str


class TranscribeResponse(BaseModel):
    text: str
    segments: list[Segment]


class JobCallback(BaseModel):
    progress_url: str | None = None
    progress_token: str | None = None


class CreateJobRequest(BaseModel):
    type: str
    input: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    callback: JobCallback | None = None


class JobStatus(BaseModel):
    id: str
    type: str
    status: str
    progress: int
    stage: str
    error: str | None = None
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None


class JobResultResponse(BaseModel):
    id: str
    type: str
    result: dict[str, Any]


@app.on_event("startup")
def startup() -> None:
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    start_job_worker()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/capabilities")
def capabilities(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_worker_token(authorization)
    return {
        "service": "listen-panel-gpu-worker",
        "version": "1.0",
        "queue": "in_memory",
        "max_concurrent_jobs": 1,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "data_dir": str(DOWNLOAD_DIR),
        "capabilities": [
            {
                "type": "asr.transcribe",
                "models": [DEFAULT_MODEL],
                "default_model": DEFAULT_MODEL,
                "languages": ["en"],
            }
        ],
    }


@app.post("/v1/jobs", status_code=202)
def create_job(
    req: CreateJobRequest,
    authorization: str | None = Header(default=None),
) -> JobStatus:
    verify_worker_token(authorization)
    if req.type != "asr.transcribe":
        raise HTTPException(status_code=400, detail=f"unsupported job type: {req.type}")
    job_id = uuid.uuid4().hex
    record = JobRecord(id=job_id, job_type=req.type, request=req)
    with _jobs_lock:
        prune_finished_jobs_locked()
        if len(_jobs) >= MAX_JOBS:
            raise HTTPException(status_code=429, detail="too many retained jobs")
        _jobs[job_id] = record
    _job_queue.put(job_id)
    logger.info("job_id=%s type=%s event=queued", job_id, req.type)
    return job_status(record)


@app.get("/v1/jobs/{job_id}")
def get_job(
    job_id: str,
    authorization: str | None = Header(default=None),
) -> JobStatus:
    verify_worker_token(authorization)
    record = get_job_record(job_id)
    return job_status(record)


@app.get("/v1/jobs/{job_id}/result")
def get_job_result(
    job_id: str,
    authorization: str | None = Header(default=None),
) -> JobResultResponse:
    verify_worker_token(authorization)
    record = get_job_record(job_id)
    if record.status != "succeeded" or record.result is None:
        raise HTTPException(status_code=409, detail=f"job is {record.status}")
    return JobResultResponse(id=record.id, type=record.job_type, result=record.result)


@app.post("/v1/transcribe")
def transcribe(
    req: TranscribeRequest,
    authorization: str | None = Header(default=None),
) -> TranscribeResponse:
    verify_worker_token(authorization)
    return run_transcribe(req)


def run_transcribe(req: TranscribeRequest) -> TranscribeResponse:
    work_dir = DOWNLOAD_DIR / f"job-{req.job_id}-{uuid.uuid4().hex[:8]}"
    work_dir.mkdir(parents=True, exist_ok=False)
    started_at = time.monotonic()
    log_job(
        req,
        "received",
        source_type=req.source_type,
        source_ref=req.source_ref,
        model=req.model,
        language=req.language,
        work_dir=str(work_dir),
    )
    report_progress(req, 5, "received")
    try:
        subtitle = try_fetch_subtitle(req, work_dir)
        if subtitle:
            log_job(req, "subtitle-found", path=str(subtitle))
            segments = parse_subtitle(subtitle)
            log_job(req, "subtitle-parsed", segments=len(segments))
            if segments:
                report_progress(req, 95, "subtitle-parsed")
                response = response_from_segments(segments)
                log_job(
                    req,
                    "completed-from-subtitle",
                    segments=len(response.segments),
                    elapsed=f"{time.monotonic() - started_at:.1f}s",
                )
                return response

        media = fetch_media(req, work_dir)
        audio = extract_audio(media, work_dir)
        response = transcribe_audio(req, audio)
        log_job(
            req,
            "completed-from-asr",
            segments=len(response.segments),
            elapsed=f"{time.monotonic() - started_at:.1f}s",
        )
        return response
    finally:
        if not KEEP_MEDIA:
            log_job(req, "cleanup", work_dir=str(work_dir))
            shutil.rmtree(work_dir, ignore_errors=True)


def start_job_worker() -> None:
    global _job_worker_started
    with _jobs_lock:
        if _job_worker_started:
            return
        _job_worker_started = True
    thread = threading.Thread(target=job_worker_loop, name="gpu-job-worker", daemon=True)
    thread.start()
    logger.info("event=job-worker-started queue=in_memory max_concurrent_jobs=1")


def job_worker_loop() -> None:
    while True:
        job_id = _job_queue.get()
        try:
            execute_job(job_id)
        except Exception:
            logger.exception("job_id=%s event=job-worker-unhandled-error", job_id)
            mark_job_failed(job_id, "internal worker error")
        finally:
            _job_queue.task_done()


def execute_job(job_id: str) -> None:
    record = get_job_record(job_id)
    mark_job_running(job_id)
    started_at = time.monotonic()
    logger.info("job_id=%s type=%s event=job-started", job_id, record.job_type)
    try:
        if record.job_type == "asr.transcribe":
            transcribe_req = transcribe_request_from_job(record)
            response = run_transcribe(transcribe_req)
            result = model_to_dict(response)
        else:
            raise HTTPException(
                status_code=400, detail=f"unsupported job type: {record.job_type}"
            )
    except HTTPException as exc:
        mark_job_failed(job_id, str(exc.detail))
        logger.warning(
            "job_id=%s type=%s event=job-failed error=%s elapsed=%.1fs",
            job_id,
            record.job_type,
            exc.detail,
            time.monotonic() - started_at,
        )
        return
    except Exception as exc:
        mark_job_failed(job_id, str(exc))
        logger.exception(
            "job_id=%s type=%s event=job-failed elapsed=%.1fs",
            job_id,
            record.job_type,
            time.monotonic() - started_at,
        )
        return
    mark_job_succeeded(job_id, result)
    logger.info(
        "job_id=%s type=%s event=job-succeeded elapsed=%.1fs",
        job_id,
        record.job_type,
        time.monotonic() - started_at,
    )


def transcribe_request_from_job(record: JobRecord) -> TranscribeRequest:
    payload = record.request.input
    options = record.request.options
    callback = record.request.callback
    data = {
        "job_id": record.id,
        "source_type": payload.get("source_type"),
        "source_ref": payload.get("source_ref"),
        "media_url": payload.get("media_url"),
        "media_token": payload.get("media_token"),
        "model": options.get("model", DEFAULT_MODEL),
        "language": options.get("language", "en"),
        "beam_size": options.get("beam_size", 5),
        "vad_filter": options.get("vad_filter", True),
        "condition_on_previous_text": options.get(
            "condition_on_previous_text", False
        ),
        "progress_url": (
            callback.progress_url
            if callback and callback.progress_url
            else payload.get("progress_url")
        ),
        "progress_token": (
            callback.progress_token
            if callback and callback.progress_token
            else payload.get("progress_token")
        ),
    }
    return TranscribeRequest(**data)


def get_job_record(job_id: str) -> JobRecord:
    with _jobs_lock:
        record = _jobs.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="job not found")
    return record


def mark_job_running(job_id: str) -> None:
    with _jobs_lock:
        record = _jobs.get(job_id)
        if record is None:
            return
        record.status = "running"
        record.progress = max(record.progress, 1)
        record.stage = "running"
        record.started_at = utc_now()


def update_internal_job_progress(job_id: str, progress: int, stage: str) -> None:
    with _jobs_lock:
        record = _jobs.get(job_id)
        if record is None or record.status != "running":
            return
        record.progress = max(record.progress, max(0, min(99, progress)))
        record.stage = stage


def mark_job_succeeded(job_id: str, result: dict[str, Any]) -> None:
    with _jobs_lock:
        record = _jobs.get(job_id)
        if record is None:
            return
        record.status = "succeeded"
        record.progress = 100
        record.stage = "completed"
        record.error = None
        record.result = result
        record.completed_at = utc_now()


def mark_job_failed(job_id: str, error: str) -> None:
    with _jobs_lock:
        record = _jobs.get(job_id)
        if record is None:
            return
        record.status = "failed"
        record.progress = 100
        record.stage = "failed"
        record.error = error[-2000:]
        record.completed_at = utc_now()


def prune_finished_jobs_locked() -> None:
    if len(_jobs) < MAX_JOBS:
        return
    finished = [
        record
        for record in _jobs.values()
        if record.status in {"succeeded", "failed", "canceled"}
    ]
    finished.sort(key=lambda record: record.completed_at or record.created_at)
    for record in finished[: max(1, len(_jobs) - MAX_JOBS + 1)]:
        _jobs.pop(record.id, None)


def job_status(record: JobRecord) -> JobStatus:
    return JobStatus(
        id=record.id,
        type=record.job_type,
        status=record.status,
        progress=record.progress,
        stage=record.stage,
        error=record.error,
        created_at=record.created_at,
        started_at=record.started_at,
        completed_at=record.completed_at,
    )


def model_to_dict(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def log_job(req: TranscribeRequest, event: str, **fields: Any) -> None:
    extras = " ".join(f"{key}={value}" for key, value in fields.items())
    if extras:
        logger.info("job_id=%s event=%s %s", req.job_id, event, extras)
    else:
        logger.info("job_id=%s event=%s", req.job_id, event)


def report_progress(req: TranscribeRequest, progress: int, stage: str) -> None:
    update_internal_job_progress(str(req.job_id), progress, stage)
    if not req.progress_url:
        return
    headers = {}
    if req.progress_token:
        headers["Authorization"] = f"Bearer {req.progress_token}"
    try:
        requests.post(
            req.progress_url,
            json={"progress": max(5, min(99, progress)), "stage": stage},
            headers=headers,
            timeout=5,
        )
    except requests.RequestException as exc:
        log_job(req, "progress-report-failed", stage=stage, error=exc)


def verify_worker_token(authorization: str | None) -> None:
    if not SHARED_TOKEN:
        return
    expected = f"Bearer {SHARED_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid worker token")


def try_fetch_subtitle(req: TranscribeRequest, work_dir: Path) -> Path | None:
    if req.source_type not in {"youtube", "bilibili"}:
        log_job(req, "subtitle-skip", reason="source_type")
        return None
    if not command_exists("yt-dlp"):
        log_job(req, "subtitle-skip", reason="yt-dlp-not-found")
        return None
    source = media_locator(req)
    log_job(req, "subtitle-fetch-start", source=source, language=req.language)
    report_progress(req, 8, "subtitle-fetch")
    output = str(work_dir / "subtitle.%(ext)s")
    cmd = [
        "yt-dlp",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        req.language,
        "--sub-format",
        "vtt/srt/best",
        "-o",
        output,
        source,
    ]
    run(cmd, check=False)
    candidates = sorted(work_dir.glob("subtitle.*"))
    log_job(req, "subtitle-fetch-done", candidates=len(candidates))
    report_progress(req, 12, "subtitle-done")
    return candidates[0] if candidates else None


def fetch_media(req: TranscribeRequest, work_dir: Path) -> Path:
    if req.media_url:
        log_job(req, "media-download-start", url=req.media_url)
        report_progress(req, 15, "media-download")
        target = work_dir / "source"
        headers = {}
        if req.media_token:
            headers["Authorization"] = f"Bearer {req.media_token}"
        with requests.get(req.media_url, headers=headers, stream=True, timeout=120) as res:
            if res.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"media download failed: HTTP {res.status_code}",
                )
            suffix = suffix_from_content_type(res.headers.get("content-type"))
            target = target.with_suffix(suffix)
            total = parse_content_length(res.headers.get("content-length"))
            downloaded = 0
            last_logged_mb = -1
            with target.open("wb") as f:
                for chunk in res.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        current_mb = downloaded // (10 * 1024 * 1024)
                        if current_mb != last_logged_mb:
                            last_logged_mb = current_mb
                            log_job(
                                req,
                                "media-download-progress",
                                downloaded_mb=f"{downloaded / 1024 / 1024:.1f}",
                                total_mb=(
                                    f"{total / 1024 / 1024:.1f}" if total else "unknown"
                                ),
                            )
                            report_progress(req, 15, "media-download")
        log_job(
            req,
            "media-download-done",
            path=str(target),
            size_mb=f"{target.stat().st_size / 1024 / 1024:.1f}",
        )
        report_progress(req, 25, "media-downloaded")
        return target

    if req.source_type in {"youtube", "bilibili"}:
        if not command_exists("yt-dlp"):
            raise HTTPException(status_code=500, detail="yt-dlp not found")
        source = media_locator(req)
        log_job(req, "yt-dlp-media-start", source=source)
        report_progress(req, 15, "yt-dlp-media")
        output = str(work_dir / "source.%(ext)s")
        run(
            [
                "yt-dlp",
                "-f",
                "bestaudio/best",
                "-o",
                output,
                source,
            ],
            check=True,
        )
        candidates = [p for p in work_dir.glob("source.*") if p.is_file()]
        if candidates:
            log_job(
                req,
                "yt-dlp-media-done",
                path=str(candidates[0]),
                size_mb=f"{candidates[0].stat().st_size / 1024 / 1024:.1f}",
            )
            report_progress(req, 25, "media-downloaded")
            return candidates[0]
    raise HTTPException(status_code=400, detail="unsupported source")


def media_locator(req: TranscribeRequest) -> str:
    source = req.source_ref.strip()
    if source.startswith(("http://", "https://")):
        return source
    if req.source_type == "bilibili" and _BILIBILI_BVID.match(source):
        return f"https://www.bilibili.com/video/{source}"
    if req.source_type == "youtube" and _YOUTUBE_ID.match(source):
        return f"https://www.youtube.com/watch?v={source}"
    return source


def extract_audio(media: Path, work_dir: Path) -> Path:
    audio = work_dir / "audio.wav"
    logger.info("event=ffmpeg-start media=%s audio=%s", media, audio)
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(media),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(audio),
        ],
        check=True,
    )
    logger.info(
        "event=ffmpeg-done audio=%s size_mb=%.1f duration=%.1fs",
        audio,
        audio.stat().st_size / 1024 / 1024,
        probe_duration(audio) or 0,
    )
    return audio


def transcribe_audio(req: TranscribeRequest, audio: Path) -> TranscribeResponse:
    duration = probe_duration(audio)
    log_job(
        req,
        "asr-start",
        audio=str(audio),
        duration=f"{duration:.1f}s" if duration else "unknown",
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
    )
    report_progress(req, 35, "asr-start")
    model = load_model(req.model)
    report_progress(req, 40, "model-ready")
    segments_iter, _info = model.transcribe(
        str(audio),
        language=req.language or None,
        beam_size=req.beam_size,
        vad_filter=req.vad_filter,
        condition_on_previous_text=req.condition_on_previous_text,
    )
    segments: list[Segment] = []
    last_progress = -1
    for s in segments_iter:
        text = s.text.strip()
        if not text:
            continue
        segment = Segment(start=s.start, end=s.end, text=text)
        segments.append(segment)
        if duration and duration > 0:
            progress = min(99, 40 + int((segment.end / duration) * 55))
            if progress >= last_progress + 5:
                last_progress = progress
                log_job(
                    req,
                    "asr-progress",
                    progress=f"{progress}%",
                    at=f"{segment.end:.1f}s",
                    duration=f"{duration:.1f}s",
                    segments=len(segments),
                )
                report_progress(req, progress, "asr-progress")
        elif len(segments) % 20 == 0:
            log_job(req, "asr-progress", segments=len(segments))
            report_progress(req, min(95, 40 + len(segments)), "asr-progress")
    log_job(req, "asr-done", segments=len(segments))
    report_progress(req, 95, "asr-done")
    return response_from_segments(segments)


def load_model(model_name: str) -> WhisperModel:
    key = model_name or DEFAULT_MODEL
    model = _model_cache.get(key)
    if model is None:
        logger.info(
            "event=model-load-start model=%s device=%s compute_type=%s",
            key,
            DEVICE,
            COMPUTE_TYPE,
        )
        model = WhisperModel(key, device=DEVICE, compute_type=COMPUTE_TYPE)
        _model_cache[key] = model
        logger.info("event=model-load-done model=%s", key)
    else:
        logger.info("event=model-cache-hit model=%s", key)
    return model


def parse_subtitle(path: Path) -> list[Segment]:
    if path.suffix.lower() == ".json":
        return parse_json_subtitle(path)
    return parse_vtt_or_srt(path)


def parse_json_subtitle(path: Path) -> list[Segment]:
    data = json.loads(path.read_text(encoding="utf-8"))
    raw_segments: list[dict[str, Any]] = data.get("segments", [])
    return [
        Segment(
            start=float(x.get("start", 0.0)),
            end=float(x.get("end", 0.0)),
            text=str(x.get("text", "")).strip(),
        )
        for x in raw_segments
        if str(x.get("text", "")).strip()
    ]


def parse_vtt_or_srt(path: Path) -> list[Segment]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = [line.strip() for line in text.splitlines()]
    segments: list[Segment] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if "-->" not in line:
            i += 1
            continue
        start_raw, end_raw = line.split("-->", 1)
        start = parse_timestamp(start_raw.strip())
        end = parse_timestamp(end_raw.strip().split()[0])
        i += 1
        body: list[str] = []
        while i < len(lines) and lines[i]:
            if not lines[i].isdigit() and not lines[i].startswith("WEBVTT"):
                body.append(lines[i])
            i += 1
        text = clean_subtitle_text(" ".join(body))
        if text:
            segments.append(Segment(start=start, end=end, text=text))
        i += 1
    return segments


def parse_timestamp(value: str) -> float:
    value = value.replace(",", ".")
    parts = value.split(":")
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    if len(parts) == 2:
        minutes, seconds = parts
        return int(minutes) * 60 + float(seconds)
    return float(parts[0])


def clean_subtitle_text(text: str) -> str:
    text = _VTT_TIMESTAMP_TAG.sub("", text)
    text = _HTML_TAG.sub("", text)
    text = html.unescape(text)
    return " ".join(text.split())


def response_from_segments(segments: list[Segment]) -> TranscribeResponse:
    text = "\n\n".join(s.text for s in segments if s.text.strip())
    if not text:
        raise HTTPException(status_code=422, detail="empty transcript")
    return TranscribeResponse(text=text, segments=segments)


def suffix_from_content_type(content_type: str | None) -> str:
    if not content_type:
        return ".bin"
    content_type = content_type.split(";", 1)[0].strip().lower()
    return {
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/x-matroska": ".mkv",
        "video/quicktime": ".mov",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
    }.get(content_type, ".bin")


def parse_content_length(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def probe_duration(path: Path) -> float | None:
    if not command_exists("ffprobe"):
        return None
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        return None
    try:
        return float(completed.stdout.strip())
    except ValueError:
        return None


def run(cmd: list[str], check: bool) -> subprocess.CompletedProcess[str]:
    logger.info("event=command-start cmd=%s", " ".join(cmd))
    try:
        completed = subprocess.run(
            cmd,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"{cmd[0]} not found")
    logger.info(
        "event=command-done cmd=%s returncode=%s",
        cmd[0],
        completed.returncode,
    )
    if check and completed.returncode != 0:
        error = completed.stderr.strip() or completed.stdout.strip()
        error = error[-1000:]
        raise HTTPException(
            status_code=502,
            detail=f"{cmd[0]} failed with exit code {completed.returncode}: {error}",
        )
    return completed


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


if __name__ == "__main__":
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run("worker:app", host=HOST, port=PORT, reload=False)

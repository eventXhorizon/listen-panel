from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import uuid
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
DOWNLOAD_DIR = Path(os.getenv("ASR_DOWNLOAD_DIR", "./data"))
KEEP_MEDIA = os.getenv("ASR_KEEP_MEDIA", "0") == "1"

app = FastAPI(title="Listen Panel ASR Worker")
_model_cache: dict[str, WhisperModel] = {}
_VTT_TIMESTAMP_TAG = re.compile(r"<\d{2}:\d{2}:\d{2}\.\d{3}>")
_HTML_TAG = re.compile(r"</?[^>]+>")


class TranscribeRequest(BaseModel):
    job_id: int
    source_type: str
    source_ref: str
    media_url: str | None = None
    media_token: str | None = None
    model: str = DEFAULT_MODEL
    language: str = "en"
    beam_size: int = Field(default=5, ge=1, le=10)
    vad_filter: bool = True
    condition_on_previous_text: bool = False


class Segment(BaseModel):
    start: float
    end: float
    text: str


class TranscribeResponse(BaseModel):
    text: str
    segments: list[Segment]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/transcribe")
def transcribe(
    req: TranscribeRequest,
    authorization: str | None = Header(default=None),
) -> TranscribeResponse:
    verify_worker_token(authorization)
    work_dir = DOWNLOAD_DIR / f"job-{req.job_id}-{uuid.uuid4().hex[:8]}"
    work_dir.mkdir(parents=True, exist_ok=False)
    try:
        subtitle = try_fetch_subtitle(req, work_dir)
        if subtitle:
            segments = parse_subtitle(subtitle)
            if segments:
                return response_from_segments(segments)

        media = fetch_media(req, work_dir)
        audio = extract_audio(media, work_dir)
        return transcribe_audio(req, audio)
    finally:
        if not KEEP_MEDIA:
            shutil.rmtree(work_dir, ignore_errors=True)


def verify_worker_token(authorization: str | None) -> None:
    if not SHARED_TOKEN:
        return
    expected = f"Bearer {SHARED_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid worker token")


def try_fetch_subtitle(req: TranscribeRequest, work_dir: Path) -> Path | None:
    if req.source_type not in {"youtube", "bilibili"}:
        return None
    if not command_exists("yt-dlp"):
        return None
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
        req.source_ref,
    ]
    run(cmd, check=False)
    candidates = sorted(work_dir.glob("subtitle.*"))
    return candidates[0] if candidates else None


def fetch_media(req: TranscribeRequest, work_dir: Path) -> Path:
    if req.media_url:
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
            with target.open("wb") as f:
                for chunk in res.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
        return target

    if req.source_type in {"youtube", "bilibili"}:
        if not command_exists("yt-dlp"):
            raise HTTPException(status_code=500, detail="yt-dlp not found")
        output = str(work_dir / "source.%(ext)s")
        run(
            [
                "yt-dlp",
                "-f",
                "bestaudio/best",
                "-o",
                output,
                req.source_ref,
            ],
            check=True,
        )
        candidates = [p for p in work_dir.glob("source.*") if p.is_file()]
        if candidates:
            return candidates[0]
    raise HTTPException(status_code=400, detail="unsupported source")


def extract_audio(media: Path, work_dir: Path) -> Path:
    audio = work_dir / "audio.wav"
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
    return audio


def transcribe_audio(req: TranscribeRequest, audio: Path) -> TranscribeResponse:
    model = load_model(req.model)
    segments_iter, _info = model.transcribe(
        str(audio),
        language=req.language or None,
        beam_size=req.beam_size,
        vad_filter=req.vad_filter,
        condition_on_previous_text=req.condition_on_previous_text,
    )
    segments = [
        Segment(start=s.start, end=s.end, text=s.text.strip())
        for s in segments_iter
        if s.text.strip()
    ]
    return response_from_segments(segments)


def load_model(model_name: str) -> WhisperModel:
    key = model_name or DEFAULT_MODEL
    model = _model_cache.get(key)
    if model is None:
        model = WhisperModel(key, device=DEVICE, compute_type=COMPUTE_TYPE)
        _model_cache[key] = model
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


def run(cmd: list[str], check: bool) -> subprocess.CompletedProcess[str]:
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

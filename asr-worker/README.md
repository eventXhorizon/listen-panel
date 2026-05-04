# Listen Panel GPU Worker

GPU 机器上运行的远程计算服务。当前第一类 workload 是 ASR,后续可以继续扩展 TTS/OCR/embedding 等显卡任务。

当前 worker 同时提供两套 API:

1. 通用 Job API:`POST /v1/jobs`、`GET /v1/jobs/:id`、`GET /v1/jobs/:id/result`
2. 兼容 listen-panel 现有转写的同步 API:`POST /v1/transcribe`

`/v1/transcribe` 会继续保留,所以现有 listen-panel 配置不用立刻改。

现有 ASR 能力:

1. local 视频:从 `media_url` 下载,请求带 `Authorization: Bearer <media_token>`
2. YouTube/Bilibili:先用 `yt-dlp` 尝试下载英文字幕,没有字幕再下载音频
3. 没有可用字幕时,用 `faster-whisper` 转写

## 安装

```bash
cd asr-worker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

GPU 机器还需要:

```bash
# Ubuntu 示例
sudo apt-get install -y ffmpeg
python -m pip install -U yt-dlp
```

`faster-whisper` 的 CUDA 运行环境按你的 GPU/CUDA 版本安装。默认配置是 `large-v3 + cuda + float16`。

关键配置:

```env
ASR_HOST=0.0.0.0
ASR_PORT=8765
ASR_TOKEN=
ASR_MODEL=large-v3
ASR_DEVICE=cuda
ASR_COMPUTE_TYPE=float16
GPU_DATA_DIR=./data
GPU_MAX_JOBS=100
ASR_KEEP_MEDIA=0
ASR_LOG_LEVEL=INFO
```

- `ASR_TOKEN`:如果要从公网或隧道访问,必须设置。请求需要带 `Authorization: Bearer <token>`。
- `GPU_DATA_DIR`:worker 临时文件和后续 artifacts 的根目录。未设置时兼容旧的 `ASR_DOWNLOAD_DIR`。
- `GPU_MAX_JOBS`:内存里最多保留多少 job 状态和结果。
- `ASR_KEEP_MEDIA=1`:排错时保留下载和抽取的媒体文件;默认完成后清理。

## 启动

```bash
cp .env.example .env
# 按需编辑 .env
source .venv/bin/activate
python worker.py
```

启动后在 listen-panel 设置页填:

- Worker Base URL:`http://<GPU机器IP>:8765`
- Backend Base URL:`http://<listen-panel后端IP>:9527`
- Shared Token:如果 `ASR_TOKEN` 非空,这里填相同值
- 模型:`large-v3`
- 语言:`en`

## 通用 Job API

### Capabilities

```bash
curl http://127.0.0.1:8765/v1/capabilities
```

如果配置了 `ASR_TOKEN`:

```bash
curl -H "Authorization: Bearer $ASR_TOKEN" \
  http://127.0.0.1:8765/v1/capabilities
```

响应会列出当前支持的 workload,例如 `asr.transcribe`。

### 创建 ASR Job

```bash
curl -X POST http://127.0.0.1:8765/v1/jobs \
  -H "Content-Type: application/json" \
  --data '{
    "type": "asr.transcribe",
    "input": {
      "source_type": "youtube",
      "source_ref": "https://www.youtube.com/watch?v=xxxx"
    },
    "options": {
      "model": "large-v3",
      "language": "en",
      "beam_size": 5,
      "vad_filter": true,
      "condition_on_previous_text": false
    }
  }'
```

响应:

```json
{
  "id": "a1b2c3",
  "type": "asr.transcribe",
  "status": "queued",
  "progress": 0,
  "stage": "queued",
  "error": null,
  "created_at": "2026-05-04T12:00:00.000000Z",
  "started_at": null,
  "completed_at": null
}
```

### 查询状态

```bash
curl http://127.0.0.1:8765/v1/jobs/<job_id>
```

状态枚举:

- `queued`
- `running`
- `succeeded`
- `failed`

V1.0 是单进程内存队列,一次只跑一个 GPU job。worker 重启后 job 状态和结果会丢失。

### 查询结果

```bash
curl http://127.0.0.1:8765/v1/jobs/<job_id>/result
```

ASR 结果:

```json
{
  "id": "a1b2c3",
  "type": "asr.transcribe",
  "result": {
    "text": "full transcript",
    "segments": [
      { "start": 0.0, "end": 2.1, "text": "Hello." }
    ]
  }
}
```

## 兼容转写协议

请求:

```json
{
  "job_id": 1,
  "source_type": "local",
  "source_ref": "file.mp4",
  "media_url": "http://192.168.0.113:9527/api/asr/media/1",
  "media_token": "...",
  "model": "large-v3",
  "language": "en",
  "beam_size": 5,
  "vad_filter": true,
  "condition_on_previous_text": false
}
```

接口:

```bash
curl -X POST http://127.0.0.1:8765/v1/transcribe \
  -H "Content-Type: application/json" \
  --data @request.json
```

响应:

```json
{
  "text": "full transcript",
  "segments": [
    { "start": 0.0, "end": 2.1, "text": "Hello." }
  ]
}
```

## 运行建议

- 长视频优先使用已有字幕,worker 会先试 `yt-dlp --write-subs --write-auto-subs`。
- 如果主要学英语,listen-panel 设置里固定 `language=en`,减少模型语言误判。
- `condition_on_previous_text=false` 适合长视频,更不容易重复和跑偏。
- 如果转写速度不够,可以把 `ASR_COMPUTE_TYPE` 改成 `int8_float16`。
- 控制台会打印 job 阶段日志:收到任务、字幕抓取、媒体下载、ffmpeg、模型加载、ASR 进度、完成和清理。`asr-progress` 基于已输出 segment 的结束时间除以音频总时长估算。worker 也会把阶段进度回调到 listen-panel 后端,所以前端轮询能看到进度变化。日志级别可用 `ASR_LOG_LEVEL=INFO` 调整。

## 公网访问建议

优先使用 Tailscale/WireGuard 或 Cloudflare Tunnel,不要裸露 8765 端口。确实需要公网反代时:

- 必须设置 `ASR_TOKEN`
- 只暴露 gateway API,不要暴露其它管理端口
- 在反代层加 HTTPS、请求大小限制、访问日志和限流
- worker 临时目录放在足够大的磁盘上,并保持 `ASR_KEEP_MEDIA=0`

更完整的长期规划见 `../docs/gpu-compute-platform.md`。

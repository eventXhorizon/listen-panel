# Listen Panel ASR Worker

GPU 机器上运行的远程 ASR worker。它实现 listen-panel 后端调用的 `POST /v1/transcribe` 协议:

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

## 协议

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

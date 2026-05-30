# 部署手册

服务器上跑 listen-panel 的完整流程。新机器从零起、日常更新、回滚、常见坑都在这里。

## 架构概览

```
浏览器
  ↓ https
Cloudflare（可选）
  ↓
宿主机 nginx（可选，反代 80/443 → PUBLISH_PORT）
  ↓
listen-panel-frontend 容器（nginx，监听 80，映射到宿主 PUBLISH_PORT）
  ├─ 静态文件直接返回
  └─ /api/ 和 /health → listen-panel-backend:9527（容器内网）
       ↓ 读写
   /data（bind-mount 自宿主 DATA_DIR）
     ├─ app.db          SQLite 主库
     ├─ uploads/        用户上传的音视频
     └─ tts-cache/      TTS 缓存
```

- **没有 DB 容器** —— 用 SQLite，数据全在宿主的 `DATA_DIR`。
- **backend 端口不发布** —— 只有 frontend 容器能访问，外界打不到 9527。
- **镜像在 ghcr.io、Public** —— `docker compose pull` 不用 login。

## 一次性：新机器搭起来

前提：服务器装好 Docker（带 compose v2）。

```bash
# 1. 准备目录
mkdir -p /root/listen-panel/{deploy,data}
cd /root/listen-panel/deploy

# 2. 拷贝部署文件（从仓库或 scp 都行）
#    需要：docker-compose.yml, deploy.sh, .env.example
curl -O https://raw.githubusercontent.com/EventXHorizon/listen-panel/main/deploy/docker-compose.yml
curl -O https://raw.githubusercontent.com/EventXHorizon/listen-panel/main/deploy/deploy.sh
curl -O https://raw.githubusercontent.com/EventXHorizon/listen-panel/main/deploy/.env.example
chmod +x deploy.sh

# 3. 配置环境变量
cp .env.example .env
$EDITOR .env
#   - IMAGE_TAG 先填 latest 或 CI 最近一次的 tag
#   - YOUTUBE_API_KEY 想用新闻抓取就填

# 4. 拉起
./deploy.sh

# 5. 验证
curl -fsS http://localhost:19527/health        # 应返回 200
docker compose ps                              # 两个容器 healthy
```

首次访问 `http://<服务器IP>:19527`（或域名）会进 setup 流程创建第一个管理员。

## 日常更新（CI → 服务器）

1. 本地推到 `main`（或在 Actions 里手动 dispatch）。
2. CI 跑完，到那次 run 的 Summary 里找：
   ```
   ### 🟢 Deploy this tag
   IMAGE_TAG=20260524-1430-a1b2c3d
   ```
3. 在服务器：
   ```bash
   cd /root/listen-panel/deploy
   sed -i 's|^IMAGE_TAG=.*|IMAGE_TAG=20260524-1430-a1b2c3d|' .env
   ./deploy.sh
   ```

或不动 `.env`、一次性覆盖：
```bash
IMAGE_TAG=20260524-1430-a1b2c3d ./deploy.sh
```

## 回滚

每个 tag 都是不可变的镜像，回滚就是改回旧 tag：

```bash
# 看本地都拉过哪些 tag
docker images | grep listen-panel

# 改回上一个 tag
sed -i 's|^IMAGE_TAG=.*|IMAGE_TAG=<旧 tag>|' .env
./deploy.sh
```

如果数据库迁移在新版本里加了破坏性改动，回镜像之前先备份 `DATA_DIR`。

## 数据相关

### 备份

应用内置一键备份：登录 → 设置 → 数据备份 → 导出。下载的是 `app-<时间>.tar.gz`，包含 `app.db`（VACUUM 后的快照）+ `uploads/` + `tts-cache/` + 脱敏过 API key 的配置 JSON。

服务器级别的全量备份直接打包 `DATA_DIR`：
```bash
systemctl stop docker        # 或 docker compose down，保证 SQLite 没人写
tar czf listen-panel-$(date +%F).tar.gz -C /root/listen-panel data
systemctl start docker
```

### 上传本地 data 到新服务器

```bash
# 本地（关掉本地 backend，避免 SQLite WAL 写入）
rsync -avz --progress \
  ~/my_devs/ai_questions/listen-panel/data/ \
  root@<server>:/root/listen-panel/data/
```

### 重置管理员密码

不能 `DELETE FROM users` —— 外键 CASCADE 会把这个用户名下的所有 materials/notes/vocab/quick_notes 一起删掉。

→ 见 [admin-password-reset.md](./admin-password-reset.md)。

## 常用命令

```bash
# 看日志
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs --tail=200 backend

# 进容器（backend 是 distroless-ish 的 slim 镜像，只有 sh 和 curl，没 sqlite3）
docker exec -it listen-panel-backend sh

# 看健康
docker inspect listen-panel-backend --format '{{.State.Health.Status}}'

# 重启单个服务（不拉新镜像）
docker compose restart backend

# 完全停掉
docker compose down                  # 保留 volume / bind-mount
docker compose down --volumes        # 不要用，会删 named volume（我们没用到，但别养习惯）
```

## 宿主机 nginx（可选）

如果用 Cloudflare 直接打 `<IP>:19527` 就跳过这节。

如果在宿主 nginx 上做 80/443 反代，注意 `proxy_pass` 必须指向 `PUBLISH_PORT`（默认 19527），不是早期开发的 9527：

```nginx
# /etc/nginx/sites-available/listen-panel
server {
  listen 80;
  server_name listen.example.com;

  client_max_body_size 500M;     # 大音视频上传

  location / {
    proxy_pass http://127.0.0.1:19527;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
  }
}
```

换服务器后忘了改这里，会出现「直接 curl :19527 是 200，从域名进就 502」。

## Troubleshooting

| 症状 | 原因 / 排查 |
|---|---|
| Cloudflare 521 / 522 | 服务没起来。`docker compose ps`，确认两个容器都 healthy；或宿主 nginx 没起 / 端口不对 |
| 域名 502，但 `curl localhost:19527` 正常 | 宿主 nginx `proxy_pass` 指向了错误的端口（老 9527）。改成 19527 后 `nginx -s reload` |
| 前端页面出来了但样式全没 | Tailwind v4 的 native binary 没装。frontend 镜像构建时必须 `npm ci --include=optional`，本地复现就 `cd frontend && npm install` 后 `npm run build` 看报错 |
| CI 一直 Queued | 新 GitHub 账号 / 没启用 2FA / 没付费组织。开 SMS 2FA、加入 Enterprise org 一般能解。短期应急可以在服务器本地 build push |
| `docker compose pull` 报 `denied` | 镜像被设成 Private 了。要么改回 Public，要么在服务器 `docker login ghcr.io -u <user> -p <PAT>` |
| 修改了 `.env` 但 `docker compose` 没读到 | 必须在 `docker-compose.yml` 同一目录跑，或 `--env-file` 显式指定 |
| 备份下载到一半断了 | 大文件走 nginx 反代时调 `proxy_read_timeout`；或直接 `docker cp` 把 tar 出来 |

## 文件清单

- `docker-compose.yml` —— 两个服务的定义
- `deploy.sh` —— `pull && up -d`，幂等
- `.env.example` —— 抄一份成 `.env` 填值，`.env` 不进 git
- `admin-password-reset.md` —— 重置密码的 Python+argon2 操作
- `README.md` —— 本文件

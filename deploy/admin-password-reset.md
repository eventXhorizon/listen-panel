# 重置管理员密码

适用场景：忘记密码、初始密码太弱想换、迁移后的旧账号要改。

## 为什么不能 `DELETE FROM users`

`materials`、`notes`、`vocab`、`quick_notes` 等表都有：

```sql
user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
```

删用户 → 这个用户名下的所有学习数据全部级联删掉。**不要**走「删了重建」的路。

正确做法是 `UPDATE users SET password_hash = ?` —— `user_id` 不变，关联数据也不动。

## 为什么用 Python 而不是容器里的 sqlite3

backend 镜像是 `debian:bookworm-slim`，没装 `sqlite3` CLI。装一个或换镜像都没必要：

- 宿主 SQLite 直接打开 bind-mount 的 `app.db` 也行，但 macOS / 不同系统的 sqlite 版本与 Rust 写入版本不一致时偶尔会抱怨。
- 拉一个一次性 Python 容器：自带 `sqlite3` 模块、`pip install argon2-cffi` 装包很快、关掉即焚不留痕迹，最干净。

## 关键点：PHC 格式跨语言可验

Rust 用 `argon2` crate，Python 用 `argon2-cffi`，两者生成的 hash 都是 PHC 字符串：

```
$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
```

参数（算法、版本、memory、iterations、parallelism、salt）**全部内嵌在字符串里**。验证方只需要按字符串里的参数算一遍 hash 比较即可，**不依赖**两边默认参数是否一样。所以 Python 用自己的默认参数算出来的 hash，Rust 也能验。

唯一要求：必须是 `argon2id`（不是 `argon2i` / `argon2d`），算法名匹配。`argon2-cffi` 默认就是 id，OK。

## 操作步骤（在服务器上）

### 1. 先确认要改的用户

数据在 `DATA_DIR`（默认 `/root/listen-panel/data`），其中 `app.db` 是主库。

```bash
DATA=/root/listen-panel/data
ls -lh $DATA/app.db
```

### 2. 起一个 Python 容器，看一眼当前用户

```bash
docker run --rm -it \
  -v /root/listen-panel/data:/data \
  python:3.12-slim \
  python3 -c "
import sqlite3
con = sqlite3.connect('/data/app.db')
for row in con.execute('SELECT id, username, display_name, is_admin FROM users'):
    print(row)
"
```

记下要改的那个 `username`（或 `id`）。

### 3. 生成新 hash + UPDATE

把 `NEW_PASSWORD` 和 `TARGET_USERNAME` 换成自己的：

```bash
docker run --rm -i \
  -v /root/listen-panel/data:/data \
  python:3.12-slim \
  sh -c "pip install --quiet argon2-cffi && python3" <<'PY'
import sqlite3
from argon2 import PasswordHasher

NEW_PASSWORD = "把这里换成你想要的新密码"
TARGET_USERNAME = "admin"

ph = PasswordHasher()                 # 默认就是 argon2id
hashed = ph.hash(NEW_PASSWORD)
print("new hash:", hashed)

con = sqlite3.connect("/data/app.db")
cur = con.execute(
    "UPDATE users SET password_hash = ? WHERE username = ?",
    (hashed, TARGET_USERNAME),
)
con.commit()
print(f"rows updated: {cur.rowcount}")

# 顺手把这个用户的所有 session 清掉，强制重新登录
n = con.execute("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)", (TARGET_USERNAME,)).rowcount
con.commit()
print(f"sessions cleared: {n}")
PY
```

输出里 `rows updated: 1` 就成功了。

> **注意**：上面的命令把新密码明文写在 heredoc 里，命令历史会留痕。如果在意，事后 `history -d <num>` 或临时 `HISTCONTROL=ignorespace` 在每行前加空格。

### 4. 验证

不需要重启容器 —— backend 每次登录都直接读 `users.password_hash`，改完立即生效。

```bash
curl -sS -X POST http://localhost:19527/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"刚才设置的新密码"}'
```

返回带 `id`、`username`、`is_admin` 的 JSON 就 OK。

## 变体

### 只改密码，不清 session

把上面脚本里 `DELETE FROM sessions` 那段去掉。已登录的浏览器会继续有效直到 session 过期。

### 把某个用户升成管理员

```python
con.execute("UPDATE users SET is_admin = 1 WHERE username = ?", (TARGET_USERNAME,))
```

### 改用户名

```python
con.execute("UPDATE users SET username = ? WHERE id = ?", (NEW_NAME, USER_ID))
```

不会破坏外键 —— 外键引用的是 `users.id`，不是 `username`。

## 不要做的事

- ❌ `DELETE FROM users WHERE username = '...'` —— 级联删数据。
- ❌ 把 hash 字段填成明文 —— 登录会失败，并且明文密码进了数据库备份。
- ❌ 用 `bcrypt` / `sha256` / 其他算法生成 hash 塞进去 —— Rust 端只接受 `$argon2id$...` PHC 字符串。
- ❌ 在 backend 容器里 `docker exec ... sqlite3` —— 没装这个二进制，报 `executable file not found`。

## 一次性运维：删用户但保留数据

如果就是想干掉一个用户但他的 materials 要留给别人，先把 `user_id` 转移给目标用户，再删：

```python
SRC_ID = 3   # 要删的
DST_ID = 1   # 接管的（通常是 admin）

for table in ("materials", "notes", "vocab", "quick_notes",
              "transcription_jobs", "material_notes"):
    n = con.execute(f"UPDATE {table} SET user_id = ? WHERE user_id = ?",
                    (DST_ID, SRC_ID)).rowcount
    print(f"{table}: {n} rows transferred")

con.execute("DELETE FROM users WHERE id = ?", (SRC_ID,))
con.commit()
```

转移前先把表清单核对一遍（`SELECT name FROM sqlite_master WHERE type='table'` + grep migrations 里的 `REFERENCES users`），新加的表会让这个清单过期。

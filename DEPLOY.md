# 公网部署指南 · PolyLingua AI（Node + Express + SQLite 全栈）

部署后你会得到一个**公网网址**，任何人打开链接即可注册、登录、学课程、练句子——无需安装任何东西。

---

## 重要前提说明（请先读）

1. **数据库是 SQLite**，文件在运行时自动生成（已写进 .gitignore，不会进仓库）。
   云平台磁盘是**临时盘**：每次重新部署会重置数据。
   - 课程 / 单词 / 知识库 在启动时会自动重新种入，不受影响；
   - 但**用户账号、错题、签到、学习进度会清空**，需要重新注册。
   - 若要数据永久保存，后续可换成 Postgres（告诉我即可加）。
2. **美式发音（Edge TTS）依赖本机 Python 环境**，云端没有，会自动回退为浏览器内置发音（Web Speech API）。功能不受影响，只是音色略不同。
3. 免费套餐通常会**不活跃自动休眠**（如 Render 约 15 分钟），首次打开会有几秒冷启动。

---

## 方式一：Railway（推荐，最简单，无需 GitHub）

1. 注册 https://railway.app （可用 GitHub 账号登录，免费）
2. 在项目目录下安装并登录 CLI：
   ```bash
   npm i -g @railway/cli
   railway login        # 浏览器授权
   ```
3. 初始化并部署（首次会让你选 Empty Project）：
   ```bash
   railway init
   railway up
   ```
4. 部署完成后 Railway 会给出一个 `*.railway.app` 公网域名，直接发给别人即可。
5. 以后改了代码：`git commit` 后 `railway up` 重新部署。

---

## 方式二：Render（需一个 GitHub 仓库）

1. 在 GitHub 新建一个空仓库（例如 `polylingua-ai`）。
2. 把项目内容 push 上去：
   ```bash
   git init
   git add -A
   git commit -m "init"
   git branch -M main
   git remote add origin <你的仓库地址>
   git push -u origin main
   ```
3. 打开 https://render.com → New → **Web Service** → 关联该 GitHub 仓库。
4. 项目已自带 `render.yaml`，Render 会自动识别配置：
   - Build Command：`npm install`
   - Start Command：`npm start`
   - 健康检查：`/api/health`
5. 套餐选 **Free**，部署完成后得到 `*.onrender.com` 公网网址。

---

## 本地自测

```bash
node server.js
curl http://localhost:3001/api/health
# 期望返回 {"ok":true,"ts":...}
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口（云平台自动注入） | 3001 |
| `DB_PATH` | SQLite 数据库文件路径 | ./data.db |
| `TTS_PY` | edge-tts 的 python 路径；云端留空，前端回退浏览器发音 | 本机 venv 路径 |
| `NODE_ENV` | 运行环境 | — |

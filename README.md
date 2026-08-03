# PolyLingua AI

> **AI Multilingual Learning & Global Community Platform**
> AI 多语言学习与全球交流平台

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Express](https://img.shields.io/badge/express-4.x-blue)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/sqlite-3.x-lightgrey)](https://sqlite.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 项目定位 / Positioning

PolyLingua AI 是一个面向全球语言学习者的 AI 驱动平台。从单词记忆到场景对话，从课程学习到社区互动——让每个人都能用 AI 的力量，轻松掌握一门新语言。

PolyLingua AI is an AI-powered platform for language learners worldwide. From vocabulary acquisition to situational conversations, from structured courses to community interaction — empowering everyone to master a new language with the help of AI.

---

## 核心功能 / Features

| 模块 | 说明 |
|------|------|
| 用户系统 | 手机/邮箱注册登录，scrypt 加盐哈希密码存储，JWT Token 鉴权 |
| 会员体系 | Free / Pro / Partner 三级，支持在线升级 |
| 每日签到 | 连续签到奖励（streak+points），7 天额外 bonus |
| 课程市场 | 多语种分级课程（高考/四六级/旅游/商务/HSK），章节化学习 |
| 句子听写 | 带语法成分标注��交互式听写练习 |
| 单词查词 | 英中俄三语词典，AI 生成视觉词图，双例句 + 点击发音 |
| 错题本 | 自动收集听写错题，支持回顾复习 |
| AI 客服 | 内置智能客服回答课程/会员/合伙人/错题等问题 |
| 知识库 | 精选语言学习文章与实用表达 |
| 行为日志 | 全站用户行为追踪与分析 |
| 美式发音 | Edge TTS en-US-AriaNeural（云端自动回退浏览器合成语音）|
| AI 视觉词图 | 为单词自动生成记忆图片，强化视觉联想 |

---

## 技术栈 / Tech Stack

```
┌──────────────────────────────────┐
│         Browser (SPA)            │
│  Vanilla JS + CSS Custom Props   │
└──────────────┬───────────────────┘
               │ HTTP /api/*
┌──────────────▼───────────────────┐
│      Express.js Server           │
│  • static hosting (public/)      │
│  • REST API (/api/*)             │
│  • scrypt auth (built-in crypto) │
│  • Edge TTS proxy                │
└──────────────┬───────────────────┘
               │ better-sqlite3
┌──────────────▼───────────────────┐
│         SQLite (WAL mode)        │
│  users | sessions | courses      │
│  words | mistakes | knowledge    │
│  activities | user_words ...     │
└──────────────────────────────────┘
```

- **Backend**: Node.js + Express + better-sqlite3
- **Database**: SQLite (WAL mode, zero-config)
- **Frontend**: Single-page vanilla JS, same-origin served (no CORS)
- **Auth**: crypto.scrypt salted hash, Bearer token
- **TTS**: Edge TTS (en-US-AriaNeural) with browser Web Speech fallback
- **Deploy**: Railway / Render / Docker

---

## 快速开始 / Quick Start

### 本地运行

```bash
# 安装依赖
npm install

# 启动（默认端口 3001）
npm start

# 或指定端口
PORT=8080 npm start
```

浏览器打开 **http://localhost:3001**

> 演示账号：`13800008885` / `123456`

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3001 |
| `NODE_ENV` | 运行环境 | — |
| `DB_PATH` | 数据库文件路径 | ./data.db |
| `TTS_PY` | Edge TTS Python 路径 | 本地 venv 路径 |

详见 [.env.example](.env.example)

---

## 项目结构 / Project Structure

```
polylingua-ai/
├── server.js            # 后端主入口（Express + SQLite）
├── public/
│   ├── index.html       # 前端 SPA（内联 CSS + JS）
│   └── word-images/     # AI 生成的单词视觉图片
├── package.json
├── Dockerfile           # Docker 容器化
├── Procfile             # Heroku 部署
├── railway.json         # Railway 部署配置
├── render.yaml          # Render 部署配置
├── DEPLOY.md            # 部署指南
├── CHANGELOG.md
├── LICENSE              # MIT
└── .env.example
```

---

## API 文档 / API Reference

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/api/register` | 注册 | — |
| POST | `/api/login` | 登录 | — |
| GET | `/api/profile` | 获取个人资料 | Bearer |
| PATCH | `/api/profile` | 编辑个人资料 | Bearer |
| POST | `/api/checkin` | 每日签到 | Bearer |
| POST | `/api/upgrade` | 会员升级 | Bearer |
| GET | `/api/courses` | 课程列表 | Bearer |
| GET | `/api/courses/:id` | 课程详情 + 章节 | Bearer |
| GET | `/api/practice` | 句子听写练习 | Bearer |
| GET | `/api/words` | 单词查询 | Bearer |
| GET | `/api/mistakes` | 错题列表 | Bearer |
| POST | `/api/mistakes` | 新增错题 | Bearer |
| POST | `/api/track` | 行为日志 | Bearer |
| GET | `/api/tts` | 文本转语音 | Bearer |
| GET | `/api/health` | 健康检查 | — |
| GET/POST | `/api/cs` | AI 客服 | Bearer |
| POST | `/api/admin/words` | 批量导入单词 | Bearer (admin) |

---

## 部署 / Deployment

支持一键部署到主流云平台：

- **[Railway](https://railway.app)** — `railway up`（推荐，无需 GitHub）
- **[Render](https://render.com)** — 关联 GitHub 仓库自动部署
- **Docker** — `docker build -t polylingua-ai . && docker run -p 3001:3000 polylingua-ai`

详细步骤见 [DEPLOY.md](DEPLOY.md)

当前生产环境：**[https://lucky-production-e5cc.up.railway.app](https://lucky-production-e5cc.up.railway.app)**

---

## 贡献 / Contributing

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交变更 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

---

## 许可证 / License

MIT © 2026 PolyLingua AI Team — 详见 [LICENSE](LICENSE)

---

***Learn languages. Connect worlds. — 学语言，连世界。***

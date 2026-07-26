# 学语言 · 后端服务（最小闭环）

完整的用户系统原型从「纯前端 localStorage 模拟」升级为「前端 + 真实后端 API」。

## 启动方式

```bash
cd server
npm install        # 依赖已安装，首次克隆时需执行
node server.js     # 或 npm start
```

启动后访问：**http://localhost:3001**

> 前端与后端同源（Express 同时托管 `public/` 静态文件 + `/api` 接口），无需处理跨域。

## 技术栈

- **Express** —— HTTP 服务 + 静态托管
- **better-sqlite3** —— 本地 SQLite 数据库（零配置、文件即库）
- **Node 内置 crypto** —— `scrypt` 加盐哈希存储密码，无额外依赖

## 已实现的接口

| 方法 | 路径 | 说明 | 成功/失败 |
|------|------|------|-----------|
| POST | `/api/register` | 注册 `{nickname, phone, password}` | 200 返回 token+用户 / 400 / 409 已注册 |
| POST | `/api/login` | 登录 `{account, pwd}`（手机或邮箱） | 200 返回 token+用户 / 401 |
| GET  | `/api/profile` | 拉取资料（Header `Authorization: Bearer <token>`） | 200 返回用户 / 401 过期或缺失 |

## 数据库

- 文件：`server/data.db`（SQLite，首次运行自动建表）
- 表：`users`（用户主表）、`sessions`（登录令牌，30 天有效期）、`mistakes`、`activities`、`courses`、`user_courses`、`words`、`user_words`、`knowledge`、`course_lessons`（章节目录）、`practice_sentences`（句子听写练习，含分词与语法标注）
- 密码以 `scrypt(密码, 随机盐)` 的十六进制哈希存储，数据库被拿走也无法还原明文
- 返回前端的手机号已脱敏（`138****8885`），与前端 `AppState` 字段对齐

## 前端改造点（`public/index.html`）

- `doLogin` / `doRegister`：从「直接改内存」改为 `fetch` 真实接口
- 启动恢复会话：读 `localStorage.juyou_token` → `GET /api/profile` 拉真实资料
- `doLogout`：清除 token
- `localStorage` 不再存业务数据，只存登录令牌

## 已实现接口（已全部接入前端真实 API）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/checkin` | 每日签到：streak+1、points+20（连续7天额外+50）、month_signed 记录、写行为日志 |
| POST | `/api/upgrade` | 会员升级：写入 `role`（free/pro/partner） |
| GET  | `/api/mistakes` | 拉取当前用户错题列表 |
| POST | `/api/mistakes` | 新增错题（听写产生时调用） |
| POST | `/api/track` | 行为日志上报（登录/浏览/签到/练习等） |
| PATCH| `/api/profile` | 资料编辑（昵称/性别/生日/城市/邮箱）持久化 |
| GET  | `/api/courses/:id` | 课程详情 + 章节目录（course_lessons） |
| GET  | `/api/practice?courseId=` | 课程句子听写练习（practice_sentences，含语法成分标注） |
| GET  | `/api/tts?text=` | 美式发音 TTS（Edge TTS `en-US-AriaNeural`，需本地装有 edge-tts；失败返回 5xx 由前端回退 Web Speech） |

> 前端 `public/index.html` 已将上述全部改为真实接口调用：签到、会员升级、资料编辑、行为日志上报、错题本列表均落库；`localStorage` 仅存登录令牌。

## 让他人公网访问

当前为本地服务，仅本机可访问。要让别人也能用，需部署到公网服务器
（如云主机 / 容器 / 支持 Node 的 PaaS）。部署时把 `server/` 目录整体上传并
`npm install && node server.js`，用 Nginx 反向代理到 80/443 端口即可。

### 详细部署步骤（云服务器，让别人访问真后端）

前提：一台有公网 IP 的 Linux 服务器（阿里云 / 腾讯云 / 华为云 / 任意 VPS）。

1. **上传代码**：把整个 `server/` 目录传到服务器（`scp` / `git clone` / 面板上传均可）。
2. **安装依赖**：`cd server && npm install --production`
3. **常驻运行**（用 pm2，防止关掉终端进程就死）：
   ```bash
   npm install -g pm2
   pm2 start server.js --name xueyuyan
   pm2 save && pm2 startup      # 开机自启
   ```
4. **Nginx 反代**（示例，把 80 端口转发给本地 3001）：
   ```nginx
   server {
     listen 80;
     server_name 你的域名;
     location / {
       proxy_pass http://127.0.0.1:3001;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```
5. **放通防火墙** 80/443，并把域名 A 记录解析到服务器 IP。
6. 浏览器开 `http://你的域名` —— 多人注册登录，数据真正互通。

> 暂时没有公网服务器也行：
> - **同局域网**：朋友直接开 `http://你的内网IP:3001`（cmd 里 `ipconfig` 查 IPv4）。
> - **临时公网演示**：用内网穿透把本机 3001 暴露出去（见下方决策）。
>
> 端口可在启动前用环境变量覆盖：`PORT=8080 node server.js`

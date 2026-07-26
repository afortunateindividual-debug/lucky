/**
 * 学语言 - 用户系统后端（已扩展：注册/登录/资料/签到/升级/错题/行为日志/资料编辑）
 * 技术栈：Express + better-sqlite3 + 内置 crypto（scrypt 加盐哈希）
 * 前端同源托管在 public/，API 挂在 /api 下，避免跨域问题。
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'data.db');
// Edge TTS（美式发音）：默认用受管 Python venv 里的 edge-tts；可用环境变量覆盖
const TTS_PY = process.env.TTS_PY || 'C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const TTS_CACHE = path.join(__dirname, 'tts_cache');
fs.mkdirSync(TTS_CACHE, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------- 建表 ----------
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT,
  phone TEXT UNIQUE,
  email TEXT,
  password_hash TEXT,
  salt TEXT,
  role TEXT DEFAULT 'free',          -- free | pro | partner
  level INTEGER DEFAULT 1,           -- 1-5
  points INTEGER DEFAULT 0,
  total_points_earned INTEGER DEFAULT 0,
  total_points_spent INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  month_signed TEXT DEFAULT '[]',    -- JSON 数组，当月签到日期
  today_signed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  last_login TEXT,
  last_ip TEXT
)`);

// 兼容旧库：补字段
['gender', 'birthday', 'city'].forEach(col => {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`); } catch (e) {}
});

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  expires_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  sentence TEXT,
  course TEXT,
  wrong_count INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,
  text TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);

// ---------- 业务表：课程 / 单词 / 知识库 ----------
db.exec(`CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  cover TEXT,
  level TEXT,
  category TEXT,
  description TEXT,
  tags TEXT DEFAULT '[]',
  price INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  author TEXT,
  lessons_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS user_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  course_id INTEGER,
  progress INTEGER DEFAULT 0,
  joined_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, course_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(course_id) REFERENCES courses(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT,
  phonetic TEXT,
  meaning TEXT,
  example TEXT,
  image TEXT,
  level TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS user_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  word_id INTEGER,
  status INTEGER DEFAULT 0,
  reviewed_at TEXT,
  UNIQUE(user_id, word_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(word_id) REFERENCES words(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  summary TEXT,
  cover TEXT,
  tag TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

// 课程章节（目录）
db.exec(`CREATE TABLE IF NOT EXISTS course_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  seq INTEGER DEFAULT 1,
  title TEXT,
  subtitle TEXT,
  FOREIGN KEY(course_id) REFERENCES courses(id)
)`);

// 句子听写练习（含分词与语法成分标注）
db.exec(`CREATE TABLE IF NOT EXISTS practice_sentences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  seq INTEGER DEFAULT 1,
  sentence TEXT,
  translation TEXT,
  tokens TEXT DEFAULT '[]',     -- JSON: [{w:'She', tag:'主语'}, ...]
  FOREIGN KEY(course_id) REFERENCES courses(id)
)`);

// ---------- 种子数据（库为空时插入示例） ----------
function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM courses').get().c > 0) return;

  const courses = [
    { title: '新课标高中英语必修一', cover: '📘', level: '高中', category: '教材同步', description: '紧扣新课标，逐课精讲词汇语法，配套听说读写训练。', tags: ['新课标', '教材'], price: 0, views: 1280, author: '学语言教研', lessons: 24 },
    { title: '小学英语口语启蒙', cover: '🎈', level: '小学', category: '口语', description: '从26个字母到日常对话，让孩子敢说爱说。', tags: ['启蒙', '口语'], price: 0, views: 2304, author: 'Lucky老师', lessons: 30 },
    { title: '零基础成人英语', cover: '🌱', level: '零基础', category: '综合', description: '完全从零开始，建立英语语感与基础词汇量。', tags: ['成人', '零基础'], price: 29, views: 980, author: '学语言教研', lessons: 40 },
    { title: '中考语法专项突破', cover: '📐', level: '初中', category: '语法', description: '八大时态、从句、非谓语系统梳理，提分利器。', tags: ['中考', '语法'], price: 0, views: 1567, author: 'Lucky老师', lessons: 18 },
    { title: '雅思口语7分训练', cover: '🎯', level: '雅思', category: '口语', description: 'Part1-3全真话题，地道表达+逻辑框架。', tags: ['雅思', '口语'], price: 199, views: 642, author: '外籍考官Tom', lessons: 36 },
    { title: '旅游英语随手说', cover: '✈️', level: '实用', category: '场景', description: '机场、酒店、点餐、问路，出行必备300句。', tags: ['旅游', '场景'], price: 0, views: 1890, author: '学语言教研', lessons: 20 },
    { title: '商务邮件写作', cover: '💼', level: '职场', category: '写作', description: '从问候到跟进，写出专业得体的英文邮件。', tags: ['职场', '写作'], price: 99, views: 733, author: '外籍考官Tom', lessons: 15 },
    { title: '自然拼读Phonics', cover: '🔤', level: '小学', category: '拼读', description: '建立字母与发音的对应关系，见词能读。', tags: ['拼读', '小学'], price: 0, views: 2105, author: 'Lucky老师', lessons: 22 },
    { title: '高考完形填空技巧', cover: '🧩', level: '高中', category: '应试', description: '上下文逻辑+固定搭配，完形不再丢分。', tags: ['高考', '技巧'], price: 0, views: 1122, author: '学语言教研', lessons: 12 },
    { title: '美剧地道表达精讲', cover: '📺', level: '实用', category: '文化', description: '从Friends到Modern Family，学中用用中学。', tags: ['美剧', '文化'], price: 29, views: 1743, author: 'Lucky老师', lessons: 28 },
    { title: '四六级核心词汇', cover: '📚', level: '大学', category: '词汇', description: '高频词根词缀记忆法，30天突破核心词。', tags: ['四六级', '词汇'], price: 0, views: 2056, author: '学语言教研', lessons: 45 },
    { title: '日常英语听力训练', cover: '🎧', level: '综合', category: '听力', description: '慢速到常速渐进，磨出英语耳朵。', tags: ['听力', '综合'], price: 0, views: 1340, author: '外籍考官Tom', lessons: 32 }
  ];
  const insC = db.prepare('INSERT INTO courses (title, cover, level, category, description, tags, price, views, author, lessons_count) VALUES (?,?,?,?,?,?,?,?,?,?)');
  courses.forEach(c => insC.run(c.title, c.cover, c.level, c.category, c.description, JSON.stringify(c.tags), c.price, c.views, c.author, c.lessons));

  const words = [
    { word: 'Apple', phonetic: '/ˈæpl/', meaning: '苹果', example: 'I eat an apple every day.', image: '🍎', level: '小学' },
    { word: 'Vocabulary', phonetic: '/vəˈkæbjələri/', meaning: '词汇', example: 'Reading books expands your vocabulary.', image: '📝', level: '初中' },
    { word: 'Fluent', phonetic: '/ˈfluːənt/', meaning: '流利的', example: 'She is fluent in English and French.', image: '💬', level: '高中' },
    { word: 'Sunset', phonetic: '/ˈsʌnset/', meaning: '日落', example: 'We watched the sunset by the sea.', image: '🌅', level: '小学' },
    { word: 'Journey', phonetic: '/ˈdʒɜːni/', meaning: '旅程', example: 'Life is a long journey.', image: '🚀', level: '初中' },
    { word: 'Confident', phonetic: '/ˈkɒnfɪdənt/', meaning: '自信的', example: 'Be confident when you speak.', image: '💪', level: '高中' },
    { word: 'Dictionary', phonetic: '/ˈdɪkʃənri/', meaning: '词典', example: 'Keep a dictionary on your desk.', image: '📖', level: '小学' },
    { word: 'Culture', phonetic: '/ˈkʌltʃə(r)/', meaning: '文化', example: 'Food is part of culture.', image: '🏛️', level: '初中' },
    { word: 'Achieve', phonetic: '/əˈtʃiːv/', meaning: '实现', example: 'You can achieve your dream.', image: '🏆', level: '高中' },
    { word: 'Practice', phonetic: '/ˈpræktɪs/', meaning: '练习', example: 'Practice makes perfect.', image: '🔁', level: '小学' }
  ];
  const insW = db.prepare('INSERT INTO words (word, phonetic, meaning, example, image, level) VALUES (?,?,?,?,?,?)');
  words.forEach(w => insW.run(w.word, w.phonetic, w.meaning, w.example, w.image, w.level));

  const knowledge = [
    { title: '日落用英文怎么说', summary: 'sunset 是日落，但表达晚霞、暮色还有更多地道说法。', cover: '🌅', tag: '实用表达', content: 'sunset 指日落这一刻；afterglow 是日落后天边的余晖；dusk 是黄昏、暮色。可以说：We enjoyed the sunset on the beach.' },
    { title: '“看世界”的多种英文表达', summary: 'see the world 不只是旅游，更代表开阔眼界。', cover: '🌍', tag: '实用表达', content: 'see the world 看世界；broaden one’s horizons 开阔视野；travel far and wide 游遍四方。学语言，正是为了看更大的世界。' },
    { title: '可数名词与不可数名词', summary: '搞清 a/an 与量词，写作不再扣分。', cover: '📐', tag: '语法图解', content: '可数名词有单复数（apple/apples）；不可数名词无复数（water/advice）。不可数前加 a piece of / a cup of 等量词。' },
    { title: '现在完成时 vs 一般过去时', summary: '一个强调结果影响，一个只说过去动作。', cover: '⏱️', tag: '语法图解', content: 'I have lost my key.（现在还没找到） vs I lost my key yesterday.（只陈述昨天发生）。完成时连接过去与现在。' },
    { title: '连读与略音：让口语更自然', summary: '母语者为什么说得那么快？秘密在连读。', cover: '🔗', tag: '发音技巧', content: '连读：前词尾辅音+后词首元音连成一体（check it → che-kit）。略读：t/d 在辅音间常弱化。多听多模仿即可。' },
    { title: '英语国家的餐桌礼仪', summary: '出国做客，这些细节体现修养。', cover: '🍽️', tag: '文化知识', content: '等主人说 Enjoy 后再动筷；咀嚼时不说话；用完说 That was delicious。语言之外，文化是另一扇窗。' },
    { title: '如何高效背单词不遗忘', summary: '艾宾浩斯遗忘曲线告诉你：间隔复习才是王道。', cover: '🧠', tag: '学习方法', content: '当天、第2天、第4天、第7天、第15天复习，记忆留存率大幅提升。本站的背单词模块正是按此逻辑设计。' },
    { title: '英语脏话 vs 委婉语', summary: '同样意思，正式场合怎么说才得体？', cover: '🤫', tag: '文化知识', content: '想说“厕所”：非正式 restroom，正式 bathroom，委婉 powder room。掌握语域，沟通更顺畅。' },
    { title: '被动语态三步转换法', summary: '把主动变被动，抓住 be + 过去分词。', cover: '🔄', tag: '语法图解', content: '1) 宾语提前当主语；2) 加 be 动词（时态随原句）；3) 原动词变过去分词。He wrote the letter → The letter was written by him.' }
  ];
  const insK = db.prepare('INSERT INTO knowledge (title, summary, cover, tag, content) VALUES (?,?,?,?,?)');
  knowledge.forEach(k => insK.run(k.title, k.summary, k.cover, k.tag, k.content));
}
seedIfEmpty();

// ---------- 内容种子（章节 / 句子练习，独立于课程种子，库已存在也能补种） ----------
function seedContent() {
  // 每门课生成 6 个章节
  if (db.prepare('SELECT COUNT(*) c FROM course_lessons').get().c === 0) {
    const courses = db.prepare('SELECT id FROM courses ORDER BY id').all();
    const lessonTitles = [
      { t: '词汇与发音入门', s: '掌握本课核心词汇与地道美式发音' },
      { t: '核心句型精讲', s: '拆解高频实用句型结构' },
      { t: '听说实战训练', s: '跟读模仿，强化英语语感' },
      { t: '语法难点突破', s: '攻克易错语法点' },
      { t: '情景对话演练', s: '在真实场景中运用所学' },
      { t: '综合测评与复习', s: '查漏补缺，巩固提升' }
    ];
    const insL = db.prepare('INSERT INTO course_lessons (course_id, seq, title, subtitle) VALUES (?,?,?,?)');
    courses.forEach(c => lessonTitles.forEach((lt, i) => insL.run(c.id, i + 1, lt.t, lt.s)));
  }

  // 句子听写练习池（地道美式英语，含语法成分标注）
  if (db.prepare('SELECT COUNT(*) c FROM practice_sentences').get().c === 0) {
    const pool = [
      { sentence: 'She reads a book every evening.', translation: '她每天晚上读一本书。', tokens: [{w:'She',tag:'主语'},{w:'reads',tag:'谓语'},{w:'a',tag:'冠词'},{w:'book',tag:'宾语'},{w:'every evening',tag:'状语'}] },
      { sentence: 'We watched the sunset by the sea.', translation: '我们在海边看了日落。', tokens: [{w:'We',tag:'主语'},{w:'watched',tag:'谓语'},{w:'the',tag:'冠词'},{w:'sunset',tag:'宾语'},{w:'by the sea',tag:'状语'}] },
      { sentence: 'He bought a red apple at the market.', translation: '他在市场买了一个红苹果。', tokens: [{w:'He',tag:'主语'},{w:'bought',tag:'谓语'},{w:'a',tag:'冠词'},{w:'red',tag:'定语'},{w:'apple',tag:'宾语'},{w:'at the market',tag:'状语'}] },
      { sentence: 'They are learning English with great passion.', translation: '他们正充满热情地学习英语。', tokens: [{w:'They',tag:'主语'},{w:'are learning',tag:'谓语'},{w:'English',tag:'宾语'},{w:'with great passion',tag:'状语'}] },
      { sentence: 'The little boy opened the door quietly.', translation: '小男孩静静地打开了门。', tokens: [{w:'The',tag:'冠词'},{w:'little',tag:'定语'},{w:'boy',tag:'主语'},{w:'opened',tag:'谓语'},{w:'the',tag:'冠词'},{w:'door',tag:'宾语'},{w:'quietly',tag:'状语'}] },
      { sentence: 'My sister makes delicious coffee every morning.', translation: '我姐姐每天早晨煮美味的咖啡。', tokens: [{w:'My',tag:'定语'},{w:'sister',tag:'主语'},{w:'makes',tag:'谓语'},{w:'delicious',tag:'定语'},{w:'coffee',tag:'宾语'},{w:'every morning',tag:'状语'}] },
      { sentence: 'Practice makes perfect in language learning.', translation: '在语言学习中，熟能生巧。', tokens: [{w:'Practice',tag:'主语'},{w:'makes',tag:'谓语'},{w:'perfect',tag:'宾语'},{w:'in language learning',tag:'状语'}] },
      { sentence: 'The teacher explained the grammar clearly.', translation: '老师清楚地讲解了语法。', tokens: [{w:'The',tag:'冠词'},{w:'teacher',tag:'主语'},{w:'explained',tag:'谓语'},{w:'the',tag:'冠词'},{w:'grammar',tag:'宾语'},{w:'clearly',tag:'状语'}] },
      { sentence: 'I want to visit New York next summer.', translation: '我想明年夏天去纽约。', tokens: [{w:'I',tag:'主语'},{w:'want',tag:'谓语'},{w:'to visit New York',tag:'宾语'},{w:'next summer',tag:'状语'}] },
      { sentence: 'She speaks English fluently and confidently.', translation: '她流利而自信地说英语。', tokens: [{w:'She',tag:'主语'},{w:'speaks',tag:'谓语'},{w:'English',tag:'宾语'},{w:'fluently',tag:'状语'},{w:'and',tag:'连词'},{w:'confidently',tag:'状语'}] },
      { sentence: 'The students finished their homework before dinner.', translation: '学生们晚饭前做完了作业。', tokens: [{w:'The',tag:'冠词'},{w:'students',tag:'主语'},{w:'finished',tag:'谓语'},{w:'their',tag:'定语'},{w:'homework',tag:'宾语'},{w:'before dinner',tag:'状语'}] },
      { sentence: 'A good friend always listens with patience.', translation: '好朋友总是耐心地倾听。', tokens: [{w:'A',tag:'冠词'},{w:'good',tag:'定语'},{w:'friend',tag:'主语'},{w:'always',tag:'状语'},{w:'listens',tag:'谓语'},{w:'with patience',tag:'状语'}] },
      { sentence: 'We should protect the beautiful environment around us.', translation: '我们应该保护身边美丽的环境。', tokens: [{w:'We',tag:'主语'},{w:'should protect',tag:'谓语'},{w:'the',tag:'冠词'},{w:'beautiful',tag:'定语'},{w:'environment',tag:'宾语'},{w:'around us',tag:'状语'}] },
      { sentence: 'He told me an interesting story about his trip.', translation: '他给我讲了一个关于他旅行的有趣故事。', tokens: [{w:'He',tag:'主语'},{w:'told',tag:'谓语'},{w:'me',tag:'间接宾语'},{w:'an',tag:'冠词'},{w:'interesting',tag:'定语'},{w:'story',tag:'直接宾语'},{w:'about his trip',tag:'状语'}] },
      { sentence: 'Learning a language opens the door to a new world.', translation: '学习一门语言打开了通往新世界的大门。', tokens: [{w:'Learning',tag:'主语'},{w:'a',tag:'冠词'},{w:'language',tag:'定语'},{w:'opens',tag:'谓语'},{w:'the',tag:'冠词'},{w:'door',tag:'宾语'},{w:'to a new world',tag:'状语'}] }
    ];
    const insS = db.prepare('INSERT INTO practice_sentences (course_id, seq, sentence, translation, tokens) VALUES (?,?,?,?,?)');
    const courses = db.prepare('SELECT id FROM courses ORDER BY id').all();
    courses.forEach((c, ci) => {
      for (let k = 0; k < 3; k++) {
        const s = pool[(ci * 3 + k) % pool.length];
        insS.run(c.id, k + 1, s.sentence, s.translation, JSON.stringify(s.tokens));
      }
    });
  }
}
seedContent();

// ---------- 工具函数 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}
// 从请求头取已登录用户 id（token 校验）
function getUid(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const sess = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now','localtime')").get(token);
  return sess ? sess.user_id : null;
}
// 返回给前端的脱敏用户对象（手机号打码、字段名与前端 AppState 对齐）
function publicUser(u) {
  return {
    id: 'U' + String(u.id).padStart(9, '0'),
    nickname: u.nickname,
    phone: u.phone ? u.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : null,
    email: u.email,
    gender: u.gender,
    birthday: u.birthday,
    city: u.city,
    role: u.role,
    level: u.level,
    points: u.points,
    totalPointsEarned: u.total_points_earned,
    totalPointsSpent: u.total_points_spent,
    streak: u.streak,
    monthSigned: JSON.parse(u.month_signed || '[]'),
    todaySigned: !!u.today_signed,
    lastLogin: u.last_login,
    lastIp: u.last_ip,
    registerTime: u.created_at,
    createdAt: u.created_at
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 注册 ----------
app.post('/api/register', (req, res) => {
  const { nickname, phone, password } = req.body || {};
  if (!nickname || !phone || !password) {
    return res.status(400).json({ message: '请填写昵称、手机号和密码' });
  }
  if (!/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ message: '手机号格式不正确' });
  }
  const exist = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (exist) {
    return res.status(409).json({ message: '该手机号已注册，请直接登录' });
  }
  const salt = makeSalt();
  const hash = hashPassword(password, salt);
  const info = db.prepare(
    'INSERT INTO users (nickname, phone, password_hash, salt, last_ip) VALUES (?, ?, ?, ?, ?)'
  ).run(nickname, phone, hash, salt, req.ip);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = newToken();
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now','localtime', '+30 days'))"
  ).run(token, user.id);
  res.json({ token, user: publicUser(user) });
});

// ---------- 登录 ----------
app.post('/api/login', (req, res) => {
  const { account, pwd } = req.body || {};
  if (!account || !pwd) {
    return res.status(400).json({ message: '请填写账号和密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE phone = ? OR email = ?').get(account, account);
  if (!user) {
    return res.status(401).json({ message: '账号不存在' });
  }
  const hash = hashPassword(pwd, user.salt);
  if (hash !== user.password_hash) {
    return res.status(401).json({ message: '密码错误' });
  }
  db.prepare("UPDATE users SET last_login = datetime('now','localtime'), last_ip = ? WHERE id = ?").run(req.ip, user.id);
  const token = newToken();
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now','localtime', '+30 days'))"
  ).run(token, user.id);
  res.json({ token, user: publicUser(user) });
});

// ---------- 拉取资料（需登录） ----------
app.get('/api/profile', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '未登录' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(401).json({ message: '用户不存在' });
  res.json({ user: publicUser(user) });
});

// ---------- 编辑资料（需登录） ----------
app.patch('/api/profile', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '未登录' });
  const { nickname, email, gender, birthday, city } = req.body || {};
  const sets = [];
  const vals = [];
  if (nickname !== undefined) { sets.push('nickname = ?'); vals.push(nickname); }
  if (email !== undefined) { sets.push('email = ?'); vals.push(email); }
  if (gender !== undefined) { sets.push('gender = ?'); vals.push(gender); }
  if (birthday !== undefined) { sets.push('birthday = ?'); vals.push(birthday); }
  if (city !== undefined) { sets.push('city = ?'); vals.push(city); }
  if (sets.length) {
    vals.push(uid);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  res.json({ user: publicUser(user) });
});

// ---------- 每日签到（需登录） ----------
app.post('/api/checkin', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (u.today_signed) {
    return res.status(400).json({ message: '今天已经签到过啦～' });
  }
  const day = new Date().getDate();
  const monthArr = JSON.parse(u.month_signed || '[]');
  if (!monthArr.includes(day)) monthArr.push(day);
  const newStreak = u.streak + 1;
  const bonus = newStreak >= 7 ? 50 : 0;     // 连续7天额外奖励
  const add = 20 + bonus;
  db.prepare(
    'UPDATE users SET today_signed = 1, streak = ?, month_signed = ?, points = points + ?, total_points_earned = total_points_earned + ? WHERE id = ?'
  ).run(newStreak, JSON.stringify(monthArr), add, add, uid);
  db.prepare("INSERT INTO activities (user_id, type, text, detail) VALUES (?, 'checkin', '完成每日签到', ?)").run(uid, `连续${newStreak}天 · +${add}积分`);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  res.json({ user: publicUser(updated) });
});

// ---------- 会员升级（需登录） ----------
app.post('/api/upgrade', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const { tier } = req.body || {};
  if (!['free', 'pro', 'partner'].includes(tier)) {
    return res.status(400).json({ message: '无效的会员类型' });
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(tier, uid);
  db.prepare("INSERT INTO activities (user_id, type, text, detail) VALUES (?, 'upgrade', '会员升级', ?)").run(uid, `角色变更为 ${tier}`);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  res.json({ user: publicUser(user) });
});

// ---------- 错题本（需登录） ----------
app.get('/api/mistakes', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const list = db.prepare('SELECT * FROM mistakes WHERE user_id = ? ORDER BY id DESC').all(uid);
  res.json({
    mistakes: list.map(m => ({
      id: m.id,
      sentence: m.sentence,
      course: m.course,
      wrongCount: m.wrong_count,
      time: m.created_at
    }))
  });
});
app.post('/api/mistakes', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const { sentence, course } = req.body || {};
  if (!sentence) return res.status(400).json({ message: '缺少句子内容' });
  const info = db.prepare('INSERT INTO mistakes (user_id, sentence, course, wrong_count) VALUES (?, ?, ?, 1)').run(uid, sentence, course || '');
  res.json({ id: info.lastInsertRowid });
});

// ---------- 行为日志上报（需登录） ----------
app.post('/api/track', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const { type, text, detail } = req.body || {};
  if (!type || !text) return res.status(400).json({ message: '缺少参数' });
  db.prepare('INSERT INTO activities (user_id, type, text, detail) VALUES (?, ?, ?, ?)').run(uid, type, text, detail || '');
  res.json({ ok: true });
});

// ---------- 课程市场（公开） ----------
app.get('/api/courses', (req, res) => {
  const q = (req.query.q || '').trim();
  const level = (req.query.level || '').trim();
  let sql = 'SELECT * FROM courses WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (title LIKE ? OR description LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
  if (level) { sql += ' AND level = ?'; params.push(level); }
  sql += ' ORDER BY id';
  const list = db.prepare(sql).all(...params);
  res.json({ courses: list });
});

// ---------- 课程详情（公开，含章节目录） ----------
app.get('/api/courses/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ message: '课程不存在' });
  const lessons = db.prepare('SELECT id, seq, title, subtitle FROM course_lessons WHERE course_id = ? ORDER BY seq').all(c.id);
  res.json({ course: c, lessons });
});

// ---------- 句子听写练习（按课程，公开） ----------
app.get('/api/practice', (req, res) => {
  const courseId = req.query.courseId;
  if (!courseId) return res.status(400).json({ message: '缺少课程ID' });
  const list = db.prepare('SELECT id, sentence, translation, tokens, seq FROM practice_sentences WHERE course_id = ? ORDER BY seq').all(courseId);
  const sentences = list.map(s => ({
    id: s.id,
    sentence: s.sentence,
    translation: s.translation,
    tokens: JSON.parse(s.tokens || '[]'),
    seq: s.seq
  }));
  res.json({ sentences });
});

// ---------- 美式发音 TTS（Edge TTS en-US-AriaNeural，失败返回 5xx 由前端回退 Web Speech） ----------
const ttsInflight = new Map();
app.get('/api/tts', (req, res) => {
  const text = (req.query.text || '').toString().slice(0, 400);
  if (!text) return res.status(400).json({ message: '缺少文本' });
  const hash = crypto.createHash('md5').update(text).digest('hex');
  const file = path.join(TTS_CACHE, hash + '.mp3');
  const send = () => {
    res.set('Content-Type', 'audio/mpeg');
    res.set('Accept-Ranges', 'bytes');
    res.sendFile(file);
  };
  // 有效缓存（存在且非空）直接发；损坏的空文件则删掉重试
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > 0) return send();
    try { fs.unlinkSync(file); } catch (e) {}
  }
  // 并发去重：相同文本只生成一次，避免重复写文件
  if (ttsInflight.has(hash)) {
    return ttsInflight.get(hash).then(send).catch(e => res.status(502).json({ message: 'TTS 生成失败', detail: String(e) }));
  }
  const job = new Promise((resolve, reject) => {
    const p = spawn(TTS_PY, ['-m', 'edge_tts', '--voice', 'en-US-AriaNeural', '--text', text, '--write-media', file]);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject('TTS 不可用: ' + (e.message || e)));
    p.on('close', code => {
      if (code === 0 && fs.existsSync(file) && fs.statSync(file).size > 0) resolve();
      else reject((err && err.slice(0, 300)) || ('exit code ' + code));
    });
  });
  ttsInflight.set(hash, job);
  job.then(send).catch(e => {
    if (!res.headersSent) res.status(502).json({ message: 'TTS 生成失败', detail: String(e) });
  }).finally(() => ttsInflight.delete(hash));
});

// ---------- 我的课程（含进度，需登录） ----------
app.get('/api/my-courses', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const list = db.prepare(
    `SELECT c.*, uc.progress, uc.joined_at FROM courses c
     JOIN user_courses uc ON c.id = uc.course_id
     WHERE uc.user_id = ? ORDER BY uc.joined_at DESC`
  ).all(uid);
  res.json({ courses: list });
});

// ---------- 加入课程 / 更新进度（需登录） ----------
app.post('/api/course-join', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const { courseId, progress } = req.body || {};
  if (!courseId) return res.status(400).json({ message: '缺少课程ID' });
  const exist = db.prepare('SELECT * FROM user_courses WHERE user_id=? AND course_id=?').get(uid, courseId);
  if (exist) {
    if (progress !== undefined) db.prepare('UPDATE user_courses SET progress=? WHERE user_id=? AND course_id=?').run(progress, uid, courseId);
  } else {
    db.prepare('INSERT INTO user_courses (user_id, course_id, progress) VALUES (?,?,?)').run(uid, courseId, progress || 0);
  }
  res.json({ ok: true });
});

// ---------- 单词库（登录可带记忆状态） ----------
app.get('/api/words', (req, res) => {
  const uid = getUid(req);
  const q = (req.query.q || '').trim();
  const level = (req.query.level || '').trim();
  let sql = 'SELECT w.* FROM words w WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (w.word LIKE ? OR w.meaning LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
  if (level) { sql += ' AND w.level = ?'; params.push(level); }
  sql += ' ORDER BY w.id';
  const list = db.prepare(sql).all(...params);
  const statusMap = {};
  if (uid) {
    db.prepare('SELECT word_id, status FROM user_words WHERE user_id=?').all(uid).forEach(r => statusMap[r.word_id] = r.status);
  }
  res.json({ words: list.map(w => ({ ...w, status: statusMap[w.id] || 0 })) });
});

// ---------- 更新单词记忆状态（需登录） ----------
app.post('/api/word-progress', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ message: '请先登录' });
  const { wordId, status } = req.body || {};
  if (!wordId) return res.status(400).json({ message: '缺少单词ID' });
  const exist = db.prepare('SELECT * FROM user_words WHERE user_id=? AND word_id=?').get(uid, wordId);
  if (exist) {
    db.prepare("UPDATE user_words SET status=?, reviewed_at=datetime('now','localtime') WHERE user_id=? AND word_id=?").run(status, uid, wordId);
  } else {
    db.prepare("INSERT INTO user_words (user_id, word_id, status, reviewed_at) VALUES (?,?,?,datetime('now','localtime'))").run(uid, wordId, status);
  }
  res.json({ ok: true });
});

// ---------- 知识库（公开） ----------
app.get('/api/knowledge', (req, res) => {
  const list = db.prepare('SELECT * FROM knowledge ORDER BY id').all();
  res.json({ articles: list });
});

// ---------- 健康检查（云平台存活探针） ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---------- 启动 ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`学语言后端已启动： http://0.0.0.0:${PORT}`);
});

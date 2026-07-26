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
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
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
try { db.exec(`ALTER TABLE courses ADD COLUMN lang TEXT DEFAULT 'en'`); } catch (e) {}
try { db.exec(`ALTER TABLE course_lessons ADD COLUMN content TEXT DEFAULT '[]'`); } catch (e) {}
try { db.exec(`ALTER TABLE practice_quizzes ADD COLUMN lang TEXT DEFAULT 'en'`); } catch (e) {}
try { db.exec(`ALTER TABLE words ADD COLUMN lang TEXT DEFAULT 'en'`); } catch (e) {}
try { db.exec(`ALTER TABLE practice_sentences ADD COLUMN lang TEXT DEFAULT 'en'`); } catch (e) {}

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
  lang TEXT DEFAULT 'en',
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
  lang TEXT DEFAULT 'en',
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
  content TEXT DEFAULT '[]',    -- JSON: {dialogue:[{en,zh}], vocab:[{w,ph,zh}], grammar, tip}
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
  lang TEXT DEFAULT 'en',
  FOREIGN KEY(course_id) REFERENCES courses(id)
)`);

// 练习题（选择题 / 听力题）
db.exec(`CREATE TABLE IF NOT EXISTS practice_quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  type TEXT,                  -- 'choice' 选择题 | 'listen' 听力题
  question TEXT,              -- 题干（choice: 中文释义；listen: 提示语）
  prompt TEXT DEFAULT '',     -- 听力题播放的英文句子
  options TEXT DEFAULT '[]',  -- JSON 选项数组
  answer INTEGER DEFAULT 0,   -- 正确选项下标
  explain TEXT DEFAULT '',
  seq INTEGER DEFAULT 1,
  lang TEXT DEFAULT 'en',
  FOREIGN KEY(course_id) REFERENCES courses(id)
)`);

// ---------- 课程主题内容（真实差异化章节材料，中英文通用） ----------
// 英文：dialogue[{en,zh}]  vocab[{w,ph,zh}]  ；中文：dialogue[{zh,py,en}]  vocab[{w,ph,zh}]（w=汉字 ph=拼音 zh=英文释义）
const COURSE_THEMES = {
  '新课标高中英语必修一': {
    dialogues: [{ en: 'Welcome back to school, everyone.', zh: '欢迎大家回到学校。' }, { en: 'Could you tell me your summer plan?', zh: '你能告诉我你的暑假计划吗？' }],
    vocab: [{ w: 'welcome', ph: '/ˈwelkəm/', zh: '欢迎', pos: '动词', phrases: ['Welcome back to school.', 'You are welcome.'] }, { w: 'summer', ph: '/ˈsʌmə(r)/', zh: '夏天', pos: '名词', phrases: ['I love summer vacation.', 'Summer is hot.'] }, { w: 'plan', ph: '/plæn/', zh: '计划', pos: '名词', phrases: ['Do you have a plan?', 'Make a plan.'] }, { w: 'subject', ph: '/ˈsʌbdʒɪkt/', zh: '科目', pos: '名词', phrases: ['English is my favorite subject.'] }, { w: 'improve', ph: '/ɪmˈpruːv/', zh: '提高', pos: '动词', phrases: ['I want to improve my English.'] }],
    grammar: '一般过去时：描述已发生的事用动词过去式，如 I traveled to Beijing. 规则动词加 -ed，不规则需单独记。',
    tip: '每天用 3 个新词各造一句，比单纯背诵更高效。'
  },
  '小学英语口语启蒙': {
    dialogues: [{ en: 'Hello! What is your name?', zh: '你好！你叫什么名字？' }, { en: 'I like apples. They are red and sweet.', zh: '我喜欢苹果，又红又甜。' }],
    vocab: [{ w: 'hello', ph: '/həˈləʊ/', zh: '你好', pos: '其他', phrases: ['Hello, how are you?'] }, { w: 'name', ph: '/neɪm/', zh: '名字', pos: '名词', phrases: ['What is your name?'] }, { w: 'apple', ph: '/ˈæpl/', zh: '苹果', pos: '名词', phrases: ['I like red apples.'] }, { w: 'red', ph: '/red/', zh: '红色', pos: '形容词', phrases: ['The apple is red.'] }, { w: 'friend', ph: '/frend/', zh: '朋友', pos: '名词', phrases: ['He is my good friend.'] }],
    grammar: '主系表结构：I am / You are / He is。代词与 be 动词要配对。',
    tip: '给孩子看图说词，把单词和实物对应起来记得最牢。'
  },
  '零基础成人英语': {
    dialogues: [{ en: 'Nice to meet you. I am a beginner.', zh: '很高兴认识你，我是初学者。' }, { en: 'Where is the bathroom, please?', zh: '请问洗手间在哪里？' }],
    vocab: [{ w: 'beginner', ph: '/bɪˈɡɪnə(r)/', zh: '初学者', pos: '名词', phrases: ['I am a beginner.'] }, { w: 'please', ph: '/pliːz/', zh: '请', pos: '其他', phrases: ['Please sit down.'] }, { w: 'where', ph: '/weə(r)/', zh: '哪里', pos: '副词', phrases: ['Where is the bank?'] }, { w: 'water', ph: '/ˈwɔːtə(r)/', zh: '水', pos: '名词', phrases: ['I want some water.'] }, { w: 'thanks', ph: '/θæŋks/', zh: '谢谢', pos: '其他', phrases: ['Thanks a lot.'] }],
    grammar: '特殊疑问句：疑问词(What/Where/Who) + be/助动词 + 主语，如 Where are you?',
    tip: '先练 50 个最高频词，能应付日常八成场景。'
  },
  '中考语法专项突破': {
    dialogues: [{ en: 'If it rains tomorrow, we will stay home.', zh: '如果明天下雨，我们就待在家。' }, { en: 'The book which I bought is interesting.', zh: '我买的那本书很有趣。' }],
    vocab: [{ w: 'although', ph: '/ɔːlˈðəʊ/', zh: '虽然', pos: '连词', phrases: ['Although it rained, we went out.'] }, { w: 'unless', ph: '/ənˈles/', zh: '除非', pos: '连词', phrases: ['Unless you hurry, you will be late.'] }, { w: 'whether', ph: '/ˈweðə(r)/', zh: '是否', pos: '连词', phrases: ['I do not know whether he comes.'] }, { w: 'suggest', ph: '/səˈdʒest/', zh: '建议', pos: '动词', phrases: ['I suggest taking a taxi.'] }, { w: 'depend', ph: '/dɪˈpend/', zh: '取决于', pos: '动词', phrases: ['It depends on the weather.'] }],
    grammar: '条件状语从句：if / unless 引导，主将从现（主句将来时，从句一般现在时）。',
    tip: '错题本里反复错的语法点，集中刷 10 道同类题即可突破。'
  },
  '雅思口语7分训练': {
    dialogues: [{ en: 'I am keen on outdoor activities because they relieve stress.', zh: '我热衷户外运动，因为它能缓解压力。' }, { en: 'From my perspective, reading broadens the mind.', zh: '在我看来，阅读能开阔思维。' }],
    vocab: [{ w: 'perspective', ph: '/pəˈspektɪv/', zh: '观点', pos: '名词', phrases: ['From my perspective, it is good.'] }, { w: 'beneficial', ph: '/ˌbenɪˈfɪʃl/', zh: '有益的', pos: '形容词', phrases: ['Exercise is beneficial to health.'] }, { w: 'nevertheless', ph: '/ˌnevəðəˈles/', zh: '然而', pos: '副词', phrases: ['It is hard; nevertheless we try.'] }, { w: 'illustrate', ph: '/ˈɪləstreɪt/', zh: '说明', pos: '动词', phrases: ['Let me illustrate with an example.'] }, { w: 'cognitive', ph: '/ˈkɒɡnətɪv/', zh: '认知的', pos: '形容词', phrases: ['Cognitive ability means 认知能力.'] }],
    grammar: '高分连接词：Furthermore / Nevertheless / From my perspective，让回答更有逻辑层次。',
    tip: '用 PARAPHRASE 改写题目再作答，避免重复用词。'
  },
  '旅游英语随手说': {
    dialogues: [{ en: 'I would like to book a room for two nights.', zh: '我想订一间住两晚的房间。' }, { en: 'Could you recommend a local restaurant?', zh: '你能推荐一家当地餐厅吗？' }],
    vocab: [{ w: 'reserve', ph: '/rɪˈzɜːv/', zh: '预订', pos: '动词', phrases: ['I would like to reserve a room.'] }, { w: 'luggage', ph: '/ˈlʌɡɪdʒ/', zh: '行李', pos: '名词', phrases: ['Where can I leave my luggage?'] }, { w: 'departure', ph: '/dɪˈpɑːtʃə(r)/', zh: '出发', pos: '名词', phrases: ['The departure time is nine a.m.'] }, { w: 'currency', ph: '/ˈkʌrənsi/', zh: '货币', pos: '名词', phrases: ['What currency do they use?'] }, { w: 'directions', ph: '/dəˈrekʃnz/', zh: '方向', pos: '名词', phrases: ['Can you give me directions?'] }],
    grammar: '礼貌请求：Could you / Would you mind + 动词原形，比 Can you 更得体。',
    tip: '把登机、入住、点餐三场景各背 5 句，出行无忧。'
  },
  '商务邮件写作': {
    dialogues: [{ en: 'I am writing to follow up on our meeting.', zh: '我写这封邮件跟进我们的会议。' }, { en: 'Please find the attached report for your review.', zh: '请查收附件中的报告供您审阅。' }],
    vocab: [{ w: 'regarding', ph: '/rɪˈɡɑːdɪŋ/', zh: '关于', pos: '介词', phrases: ['Regarding your email, ...'] }, { w: 'attach', ph: '/əˈtætʃ/', zh: '附上', pos: '动词', phrases: ['Please attach the file.'] }, { w: 'deadline', ph: '/ˈdedlaɪn/', zh: '截止日期', pos: '名词', phrases: ['The deadline is Friday.'] }, { w: 'proposal', ph: '/prəˈpəʊzl/', zh: '提案', pos: '名词', phrases: ['I sent the proposal.'] }, { w: 'appreciate', ph: '/əˈpriːʃieɪt/', zh: '感激', pos: '动词', phrases: ['We appreciate your help.'] }],
    grammar: '正式语气：用 I would like to / We kindly request，避免缩写（do not 而非 don\'t）。',
    tip: '邮件三要素：清晰主题、一段式正文、明确行动号召。'
  },
  '自然拼读Phonics': {
    dialogues: [{ en: 'The cat sat on the map. Listen to the /æ/ sound.', zh: '猫坐在地图上，听 /æ/ 的发音。' }, { en: 'She sells seashells by the sea.', zh: '她在海边卖贝壳（练 s 音）。' }],
    vocab: [{ w: 'vowel', ph: '/ˈvaʊəl/', zh: '元音', pos: '名词', phrases: ['A, E, I, O, U are vowels.'] }, { w: 'blend', ph: '/blend/', zh: '拼读', pos: '动词', phrases: ['Blend the sounds together.'] }, { w: 'syllable', ph: '/ˈsɪləbl/', zh: '音节', pos: '名词', phrases: ['This word has two syllables.'] }, { w: 'consonant', ph: '/ˈkɒnsənənt/', zh: '辅音', pos: '名词', phrases: ['B, C, D are consonants.'] }, { w: 'rhyme', ph: '/raɪm/', zh: '押韵', pos: '名词', phrases: ['Cat and hat rhyme.'] }],
    grammar: 'CVC 规律：辅音+元音+辅音（如 cat / map），先发首音再滑到尾音。',
    tip: '用押韵儿歌磨耳朵，孩子自然建立音形对应。'
  },
  '高考完形填空技巧': {
    dialogues: [{ en: 'He hesitated, yet finally made the brave choice.', zh: '他犹豫了，但最终做出了勇敢的选择。' }, { en: 'The story teaches us to stay hopeful.', zh: '这个故事教会我们保持希望。' }],
    vocab: [{ w: 'hesitate', ph: '/ˈhezɪteɪt/', zh: '犹豫', pos: '动词', phrases: ['Feel free to ask.'] }, { w: 'recognize', ph: '/ˈrekəɡnaɪz/', zh: '认出', pos: '动词', phrases: ['I recognize your voice.'] }, { w: 'optimistic', ph: '/ˌɒptɪˈmɪstɪk/', zh: '乐观的', pos: '形容词', phrases: ['Stay optimistic about life.'] }, { w: 'effort', ph: '/ˈefət/', zh: '努力', pos: '名词', phrases: ['Hard effort pays off.'] }, { w: 'symbol', ph: '/ˈsɪmbl/', zh: '象征', pos: '名词', phrases: ['The dove is a symbol of peace.'] }],
    grammar: '上下文逻辑：完形先看首尾段定主题，再按因果/转折/递进选词。',
    tip: '第一遍通读不填，把握主旨；第二遍再逐空推理。'
  },
  '美剧地道表达精讲': {
    dialogues: [{ en: 'No big deal, it happens to everyone.', zh: '没什么大不了的，谁都会遇到。' }, { en: 'I will catch up with you later.', zh: '我晚点再跟你聊。' }],
    vocab: [{ w: 'chill', ph: '/tʃɪl/', zh: '放松', pos: '动词', phrases: ['We can just chill.'] }, { w: 'grab', ph: '/ɡræb/', zh: '随便拿/抓', pos: '动词', phrases: ['Grab a seat.'] }, { w: 'awesome', ph: '/ˈɔːsəm/', zh: '太棒了', pos: '形容词', phrases: ['This is awesome.'] }, { w: 'mess', ph: '/mes/', zh: '一团糟', pos: '名词', phrases: ['Sorry, what a mess.'] }, { w: 'hang out', ph: '/hæŋ aʊt/', zh: '闲逛', pos: '短语', phrases: ['Want to hang out?'] }],
    grammar: '口语省略：母语者常省主语和助动词，如 (I will) catch up with you later.',
    tip: '选一部喜欢的剧，同一集看三遍：英字→无字→跟读。'
  },
  '四六级核心词汇': {
    dialogues: [{ en: 'The phenomenon deserves further analysis.', zh: '这一现象值得进一步分析。' }, { en: 'We should allocate resources efficiently.', zh: '我们应高效配置资源。' }],
    vocab: [{ w: 'phenomenon', ph: '/fəˈnɒmɪnən/', zh: '现象', pos: '名词', phrases: ['A natural phenomenon.'] }, { w: 'allocate', ph: '/ˈæləkeɪt/', zh: '分配', pos: '动词', phrases: ['Allocate time wisely.'] }, { w: 'significant', ph: '/sɪɡˈnɪfɪkənt/', zh: '显著的', pos: '形容词', phrases: ['A significant change.'] }, { w: 'contribute', ph: '/kənˈtrɪbjuːt/', zh: '贡献', pos: '动词', phrases: ['Contribute to society.'] }, { w: 'equivalent', ph: '/ɪˈkwɪvələnt/', zh: '等同的', pos: '形容词', phrases: ['A is equivalent to B.'] }],
    grammar: '词根词缀：signi-(标记)+ -ficant → significant；-tion 多为名词后缀。',
    tip: '用词根串记一组词，一次记住一大片。'
  },
  '日常英语听力训练': {
    dialogues: [{ en: 'Would you like some coffee or tea?', zh: '你想喝点咖啡还是茶？' }, { en: 'The meeting has been moved to three.', zh: '会议改到三点了。' }],
    vocab: [{ w: 'schedule', ph: '/ˈʃedjuːl/', zh: '日程', pos: '名词', phrases: ['Check your schedule.'] }, { w: 'postpone', ph: '/pəˈspəʊn/', zh: '推迟', pos: '动词', phrases: ['Let us postpone the meeting.'] }, { w: 'confirm', ph: '/kənˈfɜːm/', zh: '确认', pos: '动词', phrases: ['Please confirm the time.'] }, { w: 'available', ph: '/əˈveɪləbl/', zh: '有空的', pos: '形容词', phrases: ['Are you available now?'] }, { w: 'message', ph: '/ˈmesɪdʒ/', zh: '消息', pos: '名词', phrases: ['I left a message.'] }],
    grammar: '数字与时刻：三点 fifteen 用 past/to 表达，听力先抓关键词。',
    tip: '每天 10 分钟慢速新闻，逐步切常速，耳朵越磨越灵。'
  },
  '旅游汉语轻松说': {
    dialogues: [{ zh: '你好，我想点一杯茶。', py: 'Nǐ hǎo, wǒ xiǎng diǎn yì bēi chá.', en: 'Hello, I would like a cup of tea.' }, { zh: '请问洗手间在哪里？', py: 'Qǐng wèn xǐshǒujiān zài nǎlǐ?', en: 'Where is the restroom, please?' }],
    vocab: [{ w: '你好', ph: 'nǐ hǎo', zh: '你好', en: 'hello', pos: '其他', phrases: ['你好吗？Nǐ hǎo ma?', '你好，很高兴认识你。'] }, { w: '谢谢', ph: 'xièxie', zh: '谢谢', en: 'thanks', pos: '其他', phrases: ['谢谢你！Xièxie nǐ!', '非常感谢。'] }, { w: '多少钱', ph: 'duōshao qián', zh: '多少钱', en: 'how much', pos: '短语', phrases: ['这个多少钱？Zhège duōshao qián?'] }, { w: '餐厅', ph: 'cāntīng', zh: '餐厅', en: 'restaurant', pos: '名词', phrases: ['附近有餐厅吗？Fùjìn yǒu cāntīng ma?'] }, { w: '机票', ph: 'jīpiào', zh: '机票', en: 'air ticket', pos: '名词', phrases: ['我想买机票。Wǒ xiǎng mǎi jīpiào.'] }],
    grammar: '基本语序：主语+动词+宾语，如 我(主) 想(动) 喝茶(宾)。疑问句加"吗"：你好吗？',
    tip: '先练"你好/谢谢/多少钱"三句，走遍景点不怕开口。'
  },
  '日常中文口语': {
    dialogues: [{ zh: '你今天过得怎么样？', py: 'Nǐ jīntiān guò de zěnmeyàng?', en: 'How was your day today?' }, { zh: '我们周末一起去爬山吧！', py: 'Wǒmen zhōumò yìqǐ qù páshān ba!', en: 'Let\'s go hiking together this weekend!' }],
    vocab: [{ w: '朋友', ph: 'péngyou', zh: '朋友', en: 'friend', pos: '名词', phrases: ['他是我的朋友。Tā shì wǒ de péngyou.'] }, { w: '吃饭', ph: 'chīfàn', zh: '吃饭', en: 'eat', pos: '动词', phrases: ['我们一起吃饭吧。Wǒmen yìqǐ chīfàn ba.'] }, { w: '工作', ph: 'gōngzuò', zh: '工作', en: 'work', pos: '动词', phrases: ['你工作忙吗？Nǐ gōngzuò máng ma?'] }, { w: '开心', ph: 'kāixīn', zh: '开心', en: 'happy', pos: '形容词', phrases: ['今天很开心。Jīntiān hěn kāixīn.'] }, { w: '明天', ph: 'míngtiān', zh: '明天', en: 'tomorrow', pos: '名词', phrases: ['明天见！Míngtiān jiàn!'] }],
    grammar: '语气词"吧"表建议：我们一起去吧！"了"表完成：我吃饭了。',
    tip: '用"主语+动词+宾语"造日常句，每天 5 句就能聊起来。'
  },
  'HSK1汉字与语法基础': {
    dialogues: [{ zh: '我是学生，我学习汉语。', py: 'Wǒ shì xuéshēng, wǒ xuéxí hànyǔ.', en: 'I am a student, I study Chinese.' }, { zh: '这本书很有意思。', py: 'Zhè běn shū hěn yǒu yìsi.', en: 'This book is very interesting.' }],
    vocab: [{ w: '我', ph: 'wǒ', zh: '我', en: 'I', pos: '代词', phrases: ['我是学生。Wǒ shì xuéshēng.'] }, { w: '是', ph: 'shì', zh: '是', en: 'be', pos: '动词', phrases: ['这是书。Zhè shì shū.'] }, { w: '学习', ph: 'xuéxí', zh: '学习', en: 'study', pos: '动词', phrases: ['我学习汉语。Wǒ xuéxí hànyǔ.'] }, { w: '老师', ph: 'lǎoshī', zh: '老师', en: 'teacher', pos: '名词', phrases: ['老师好！Lǎoshī hǎo!'] }, { w: '中国', ph: 'Zhōngguó', zh: '中国', en: 'China', pos: '名词', phrases: ['我是中国人。Wǒ shì Zhōngguó rén.'] }],
    grammar: '"是"字句：A 是 B。否定用"不是"。"很"表程度：很有意思。',
    tip: 'HSK1 需掌握 150 词、基本句式，配合笔画书写记忆更牢。'
  }
};

// 由主题生成 6 章真实内容
function buildLessons(theme) {
  const d = theme.dialogues || [];
  const v = theme.vocab || [];
  const titles = [
    { t: '词汇与发音', s: '掌握本课核心词汇与地道发音' },
    { t: '核心句型精讲', s: '拆解高频实用句型结构' },
    { t: '听说实战训练', s: '跟读模仿，强化语感' },
    { t: '语法难点突破', s: '攻克易错语法点' },
    { t: '情景对话演练', s: '在真实场景中运用所学' },
    { t: '综合测评与复习', s: '查漏补缺，巩固提升' }
  ];
  return titles.map((tt, i) => {
    const content = { dialogue: [], vocab: [], grammar: '', tip: '' };
    if (i === 0 || i === 5) content.vocab = v.slice(0, 5);
    if (i === 1) content.dialogue = d.slice(0, 1);
    if (i === 2 || i === 4) content.dialogue = d;
    if (i === 3 || i === 5) content.grammar = theme.grammar || '';
    if (i === 2 || i === 5) content.tip = theme.tip || '';
    return { ...tt, content };
  });
}

// ---------- 种子数据（库为空时插入示例） ----------
function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM courses').get().c > 0) return;

  const courses = [
    { title: '新课标高中英语必修一', cover: '📘', level: '高中', category: '教材同步', lang: 'en', description: '紧扣新课标，逐课精讲词汇语法，配套听说读写训练。', tags: ['新课标', '教材'], price: 0, views: 1280, author: '学语言教研', lessons: 6 },
    { title: '小学英语口语启蒙', cover: '🎈', level: '小学', category: '口语', lang: 'en', description: '从26个字母到日常对话，让孩子敢说爱说。', tags: ['启蒙', '口语'], price: 0, views: 2304, author: 'Lucky老师', lessons: 6 },
    { title: '零基础成人英语', cover: '🌱', level: '零基础', category: '综合', lang: 'en', description: '完全从零开始，建立英语语感与基础词汇量。', tags: ['成人', '零基础'], price: 29, views: 980, author: '学语言教研', lessons: 6 },
    { title: '中考语法专项突破', cover: '📐', level: '初中', category: '语法', lang: 'en', description: '八大时态、从句、非谓语系统梳理，提分利器。', tags: ['中考', '语法'], price: 0, views: 1567, author: 'Lucky老师', lessons: 6 },
    { title: '雅思口语7分训练', cover: '🎯', level: '雅思', category: '口语', lang: 'en', description: 'Part1-3全真话题，地道表达+逻辑框架。', tags: ['雅思', '口语'], price: 199, views: 642, author: '外籍考官Tom', lessons: 6 },
    { title: '旅游英语随手说', cover: '✈️', level: '实用', category: '场景', lang: 'en', description: '机场、酒店、点餐、问路，出行必备300句。', tags: ['旅游', '场景'], price: 0, views: 1890, author: '学语言教研', lessons: 6 },
    { title: '商务邮件写作', cover: '💼', level: '职场', category: '写作', lang: 'en', description: '从问候到跟进，写出专业得体的英文邮件。', tags: ['职场', '写作'], price: 99, views: 733, author: '外籍考官Tom', lessons: 6 },
    { title: '自然拼读Phonics', cover: '🔤', level: '小学', category: '拼读', lang: 'en', description: '建立字母与发音的对应关系，见词能读。', tags: ['拼读', '小学'], price: 0, views: 2105, author: 'Lucky老师', lessons: 6 },
    { title: '高考完形填空技巧', cover: '🧩', level: '高中', category: '应试', lang: 'en', description: '上下文逻辑+固定搭配，完形不再丢分。', tags: ['高考', '技巧'], price: 0, views: 1122, author: '学语言教研', lessons: 6 },
    { title: '美剧地道表达精讲', cover: '📺', level: '实用', category: '文化', lang: 'en', description: '从Friends到Modern Family，学中用用中学。', tags: ['美剧', '文化'], price: 29, views: 1743, author: 'Lucky老师', lessons: 6 },
    { title: '四六级核心词汇', cover: '📚', level: '大学', category: '词汇', lang: 'en', description: '高频词根词缀记忆法，30天突破核心词。', tags: ['四六级', '词汇'], price: 0, views: 2056, author: '学语言教研', lessons: 6 },
    { title: '日常英语听力训练', cover: '🎧', level: '综合', category: '听力', lang: 'en', description: '慢速到常速渐进，磨出英语耳朵。', tags: ['听力', '综合'], price: 0, views: 1340, author: '外籍考官Tom', lessons: 6 },
    { title: '旅游汉语轻松说', cover: '🏯', level: '入门', category: '场景', lang: 'zh', description: '出国旅游、景点购物、餐厅点单，最常用的汉语开口就说。', tags: ['汉语', '旅游'], price: 0, views: 860, author: '学语言教研', lessons: 6 },
    { title: '日常中文口语', cover: '💬', level: '入门', category: '口语', lang: 'zh', description: '从打招呼到约朋友，老外也能聊的中文日常对话。', tags: ['汉语', '口语'], price: 0, views: 1102, author: 'Lucky老师', lessons: 6 },
    { title: 'HSK1汉字与语法基础', cover: '🀄', level: 'HSK1', category: '基础', lang: 'zh', description: '系统学150核心词与基本句式，打好汉语根基。', tags: ['HSK', '基础'], price: 29, views: 540, author: '学语言教研', lessons: 6 }
  ];
  const insC = db.prepare('INSERT INTO courses (title, cover, level, category, lang, description, tags, price, views, author, lessons_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  courses.forEach(c => insC.run(c.title, c.cover, c.level, c.category, c.lang, c.description, JSON.stringify(c.tags), c.price, c.views, c.author, c.lessons));

  const words = [
    { word: 'Apple', phonetic: '/ˈæpl/', meaning: '苹果', example: 'I eat an apple every day.', image: '🍎', level: '小学', lang: 'en' },
    { word: 'Vocabulary', phonetic: '/vəˈkæbjələri/', meaning: '词汇', example: 'Reading books expands your vocabulary.', image: '📝', level: '初中', lang: 'en' },
    { word: 'Fluent', phonetic: '/ˈfluːənt/', meaning: '流利的', example: 'She is fluent in English and French.', image: '💬', level: '高中', lang: 'en' },
    { word: 'Sunset', phonetic: '/ˈsʌnset/', meaning: '日落', example: 'We watched the sunset by the sea.', image: '🌅', level: '小学', lang: 'en' },
    { word: 'Journey', phonetic: '/ˈdʒɜːni/', meaning: '旅程', example: 'Life is a long journey.', image: '🚀', level: '初中', lang: 'en' },
    { word: 'Confident', phonetic: '/ˈkɒnfɪdənt/', meaning: '自信的', example: 'Be confident when you speak.', image: '💪', level: '高中', lang: 'en' },
    { word: 'Dictionary', phonetic: '/ˈdɪkʃənri/', meaning: '词典', example: 'Keep a dictionary on your desk.', image: '📖', level: '小学', lang: 'en' },
    { word: 'Culture', phonetic: '/ˈkʌltʃə(r)/', meaning: '文化', example: 'Food is part of culture.', image: '🏛️', level: '初中', lang: 'en' },
    { word: 'Achieve', phonetic: '/əˈtʃiːv/', meaning: '实现', example: 'You can achieve your dream.', image: '🏆', level: '高中', lang: 'en' },
    { word: 'Practice', phonetic: '/ˈpræktɪs/', meaning: '练习', example: 'Practice makes perfect.', image: '🔁', level: '小学', lang: 'en' },
    { word: 'Welcome', phonetic: '/ˈwelkəm/', meaning: '欢迎', example: 'Welcome to our school.', image: '👋', level: '小学', lang: 'en' },
    { word: 'Reserve', phonetic: '/rɪˈzɜːv/', meaning: '预订', example: 'I reserve a table for two.', image: '📅', level: '实用', lang: 'en' },
    { word: 'Beneficial', phonetic: '/ˌbenɪˈfɪʃl/', meaning: '有益的', example: 'Reading is beneficial to you.', image: '🌟', level: '雅思', lang: 'en' },
    { word: 'Schedule', phonetic: '/ˈʃedjuːl/', meaning: '日程', example: 'Check your schedule please.', image: '🗓️', level: '综合', lang: 'en' },
    { word: '你好', phonetic: 'nǐ hǎo', meaning: '你好/hello', example: '你好，很高兴认识你。', image: '👋', level: '入门', lang: 'zh' },
    { word: '谢谢', phonetic: 'xièxie', meaning: '谢谢/thanks', example: '谢谢你帮我。', image: '🙏', level: '入门', lang: 'zh' },
    { word: '学习', phonetic: 'xuéxí', meaning: '学习/study', example: '我学习汉语。', image: '📚', level: 'HSK1', lang: 'zh' },
    { word: '朋友', phonetic: 'péngyou', meaning: '朋友/friend', example: '他是我的朋友。', image: '🤝', level: '入门', lang: 'zh' },
    { word: '吃饭', phonetic: 'chīfàn', meaning: '吃饭/eat', example: '我们一起吃饭吧。', image: '🍚', level: '入门', lang: 'zh' },
    { word: '老师', phonetic: 'lǎoshī', meaning: '老师/teacher', example: '老师好！', image: '👩‍🏫', level: 'HSK1', lang: 'zh' }
  ];
  const insW = db.prepare('INSERT INTO words (word, phonetic, meaning, example, image, level, lang) VALUES (?,?,?,?,?,?,?)');
  words.forEach(w => insW.run(w.word, w.phonetic, w.meaning, w.example, w.image, w.level, w.lang));

  const knowledge = [
    { title: '日落用英文怎么说', summary: 'sunset 是日落，但表达晚霞、暮色还有更多地道说法。', cover: '🌅', tag: '实用表达', content: 'sunset 指日落这一刻；afterglow 是日落后天边的余晖；dusk 是黄昏、暮色。可以说：We enjoyed the sunset on the beach.' },
    { title: '“看世界”的多种英文表达', summary: 'see the world 不只是旅游，更代表开阔眼界。', cover: '🌍', tag: '实用表达', content: 'see the world 看世界；broaden one’s horizons 开阔视野；travel far and wide 游遍四方。学语言，正是为了看更大的世界。' },
    { title: '可数名词与不可数名词', summary: '搞清 a/an 与量词，写作不再扣分。', cover: '📐', tag: '语法图解', content: '可数名词有单复数（apple/apples）；不可数名词无复数（water/advice）。不可数前加 a piece of / a cup of 等量词。' },
    { title: '现在完成时 vs 一般过去时', summary: '一个强调结果影响，一个只说过去动作。', cover: '⏱️', tag: '语法图解', content: 'I have lost my key.（现在还没找到） vs I lost my key yesterday.（只陈述昨天发生）。完成时连接过去与现在。' },
    { title: '连读与略音：让口语更自然', summary: '母语者为什么说得那么快？秘密在连读。', cover: '🔗', tag: '发音技巧', content: '连读：前词尾辅音+后词首元音连成一体（check it → che-kit）。略读：t/d 在辅音间常弱化。多听多模仿即可。' },
    { title: '英语国家的餐桌礼仪', summary: '出国做客，这些细节体现修养。', cover: '🍽️', tag: '文化知识', content: '等主人说 Enjoy 后再动筷；咀嚼时不说话；用完说 That was delicious。语言之外，文化是另一扇窗。' },
    { title: '如何高效背单词不遗忘', summary: '艾宾浩斯遗忘曲线告诉你：间隔复习才是王道。', cover: '🧠', tag: '学习方法', content: '当天、第2天、第4天、第7天、第15天复习，记忆留存率大幅提升。本站的背单词模块正是按此逻辑设计。' },
    { title: '英语脏话 vs 委婉语', summary: '同样意思，正式场合怎么说才得体？', cover: '🤫', tag: '文化知识', content: '想说“厕所”：非正式 restroom，正式 bathroom，委婉 powder room。掌握语域，沟通更顺畅。' },
    { title: '被动语态三步转换法', summary: '把主动变被动，抓住 be + 过去分词。', cover: '🔄', tag: '语法图解', content: '1) 宾语提前当主语；2) 加 be 动词（时态随原句）；3) 原动词变过去分词。He wrote the letter → The letter was written by him.' },
    { title: '汉语拼音四声调', summary: '一声平、二声扬、三声拐弯、四声降，声调错意思就变。', cover: '🀄', tag: '汉语基础', content: 'mā(妈) má(麻) mǎ(马) mà(骂)。声调是汉语的灵魂，初学先练准四声再连读。' },
    { title: '“了”的两种用法', summary: '动态助词“了”表完成，语气词“了”表新情况。', cover: '✍️', tag: '汉语语法', content: '我吃饭了（完成）；天冷了（新情况）。区分位置：动词后 vs 句末。' }
  ];
  const insK = db.prepare('INSERT INTO knowledge (title, summary, cover, tag, content) VALUES (?,?,?,?,?)');
  knowledge.forEach(k => insK.run(k.title, k.summary, k.cover, k.tag, k.content));
}
seedIfEmpty();

// ---------- 内容种子（章节 / 句子练习，独立于课程种子，库已存在也能补种） ----------
function seedContent() {
  // 每门课由主题生成 6 章真实内容（含对话/词汇/语法/技巧）
  if (db.prepare('SELECT COUNT(*) c FROM course_lessons').get().c === 0) {
    const courses = db.prepare('SELECT id, title FROM courses ORDER BY id').all();
    const insL = db.prepare('INSERT INTO course_lessons (course_id, seq, title, subtitle, content) VALUES (?,?,?,?,?)');
    courses.forEach(c => {
      const theme = COURSE_THEMES[c.title];
      const lessons = theme ? buildLessons(theme) : [
        { t: '词汇与发音', s: '掌握本课核心词汇与地道发音', content: { dialogue: [], vocab: [], grammar: '', tip: '' } },
        { t: '核心句型精讲', s: '拆解高频实用句型结构', content: { dialogue: [], vocab: [], grammar: '', tip: '' } },
        { t: '听说实战训练', s: '跟读模仿，强化语感', content: { dialogue: [], vocab: [], grammar: '', tip: '' } },
        { t: '语法难点突破', s: '攻克易错语法点', content: { dialogue: [], vocab: [], grammar: '', tip: '' } },
        { t: '情景对话演练', s: '在真实场景中运用所学', content: { dialogue: [], vocab: [], grammar: '', tip: '' } },
        { t: '综合测评与复习', s: '查漏补缺，巩固提升', content: { dialogue: [], vocab: [], grammar: '', tip: '' } }
      ];
      lessons.forEach((lt, i) => insL.run(c.id, i + 1, lt.t, lt.s, JSON.stringify(lt.content)));
    });
  }

  // 句子听写练习池（含语法成分标注），英文+中文
  if (db.prepare('SELECT COUNT(*) c FROM practice_sentences').get().c === 0) {
    const zhPool = [
      { sentence: '你好，很高兴认识你。', translation: 'Hello, nice to meet you.', tokens: [{w:'你好',tag:'问候'},{w:'很高兴',tag:'态度'},{w:'认识',tag:'动词'},{w:'你',tag:'宾语'}], lang: 'zh' },
      { sentence: '我想点一杯茶。', translation: 'I would like a cup of tea.', tokens: [{w:'我',tag:'主语'},{w:'想',tag:'能愿'},{w:'点',tag:'动词'},{w:'一杯茶',tag:'宾语'}], lang: 'zh' },
      { sentence: '请问洗手间在哪里？', translation: 'Where is the restroom, please?', tokens: [{w:'请问',tag:'礼貌'},{w:'洗手间',tag:'主语'},{w:'在',tag:'动词'},{w:'哪里',tag:'疑问'}], lang: 'zh' },
      { sentence: '这本书很有意思。', translation: 'This book is very interesting.', tokens: [{w:'这本书',tag:'主语'},{w:'很',tag:'程度'},{w:'有意思',tag:'谓语'}], lang: 'zh' },
      { sentence: '我们周末一起去爬山吧。', translation: 'Let us go hiking together this weekend.', tokens: [{w:'我们',tag:'主语'},{w:'周末',tag:'时间'},{w:'一起',tag:'状语'},{w:'爬山',tag:'谓语'}], lang: 'zh' }
    ];
    const enPool = [
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
    const insS = db.prepare('INSERT INTO practice_sentences (course_id, seq, sentence, translation, tokens, lang) VALUES (?,?,?,?,?,?)');
    const courses = db.prepare('SELECT id, lang FROM courses ORDER BY id').all();
    courses.forEach((c, ci) => {
      const pool = c.lang === 'zh' ? zhPool : enPool;
      for (let k = 0; k < 3; k++) {
        const s = pool[(ci * 3 + k) % pool.length];
        insS.run(c.id, k + 1, s.sentence, s.translation, JSON.stringify(s.tokens), c.lang);
      }
    });
  }

  // 练习题（选择题 + 听力题），英文+中文
  if (db.prepare('SELECT COUNT(*) c FROM practice_quizzes').get().c === 0) {
    const zhSrc = [
      { s: '你好，很高兴认识你。', t: 'Hello, nice to meet you.' },
      { s: '我想点一杯茶。', t: 'I would like a cup of tea.' },
      { s: '请问洗手间在哪里？', t: 'Where is the restroom, please?' },
      { s: '这本书很有意思。', t: 'This book is very interesting.' },
      { s: '我们周末一起去爬山吧。', t: 'Let us go hiking together this weekend.' }
    ];
    const enSrc = [
      { s: 'She reads a book every evening.', t: '她每天晚上读一本书。' },
      { s: 'We watched the sunset by the sea.', t: '我们在海边看了日落。' },
      { s: 'He bought a red apple at the market.', t: '他在市场买了一个红苹果。' },
      { s: 'They are learning English with great passion.', t: '他们正充满热情地学习英语。' },
      { s: 'The little boy opened the door quietly.', t: '小男孩静静地打开了门。' },
      { s: 'My sister makes delicious coffee every morning.', t: '我姐姐每天早晨煮美味的咖啡。' },
      { s: 'Practice makes perfect in language learning.', t: '在语言学习中，熟能生巧。' },
      { s: 'The teacher explained the grammar clearly.', t: '老师清楚地讲解了语法。' },
      { s: 'I want to visit New York next summer.', t: '我想明年夏天去纽约。' },
      { s: 'She speaks English fluently and confidently.', t: '她流利而自信地说英语。' },
      { s: 'The students finished their homework before dinner.', t: '学生们晚饭前做完了作业。' },
      { s: 'A good friend always listens with patience.', t: '好朋友总是耐心地倾听。' },
      { s: 'We should protect the beautiful environment around us.', t: '我们应该保护身边美丽的环境。' },
      { s: 'He told me an interesting story about his trip.', t: '他给我讲了一个关于他旅行的有趣故事。' },
      { s: 'Learning a language opens the door to a new world.', t: '学习一门语言打开了通往新世界的大门。' }
    ];
    const courses = db.prepare('SELECT id, lang FROM courses ORDER BY id').all();
    const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const insQ = db.prepare('INSERT INTO practice_quizzes (course_id, type, question, prompt, options, answer, explain, seq, lang) VALUES (?,?,?,?,?,?,?,?,?)');
    courses.forEach((c, ci) => {
      const src = c.lang === 'zh' ? zhSrc : enSrc;
      for (let k = 0; k < 4; k++) {
        const item = src[(ci * 3 + k) % src.length];
        const distract = shuffle(src.filter(x => x.s !== item.s).map(x => x.s)).slice(0, 3);
        const opts = shuffle([item.s, ...distract]);
        insQ.run(c.id, 'choice', item.t, '', JSON.stringify(opts), opts.indexOf(item.s), '结合释义，选出对应的句子。', k + 1, c.lang);
      }
      for (let k = 0; k < 2; k++) {
        const item = src[(ci * 3 + k + 1) % src.length];
        const distract = shuffle(src.filter(x => x.t !== item.t).map(x => x.t)).slice(0, 3);
        const opts = shuffle([item.t, ...distract]);
        insQ.run(c.id, 'listen', '听音频，选出正确的意思', item.s, JSON.stringify(opts), opts.indexOf(item.t), '仔细听发音，选最贴切的译文。', k + 5, c.lang);
      }
    });
  }
  // 演示账号：云端每次全新部署都会自动创建，方便他人直接登录试用
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
    const dPhone = '13800008885';
    const dPwd = '123456';
    const dSalt = makeSalt();
    const dHash = hashPassword(dPwd, dSalt);
    db.prepare('INSERT INTO users (nickname, phone, password_hash, salt) VALUES (?,?,?,?)')
      .run('lucky', dPhone, dHash, dSalt);
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
  const lang = (req.query.lang || '').trim();
  let sql = 'SELECT * FROM courses WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (title LIKE ? OR description LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
  if (level) { sql += ' AND level = ?'; params.push(level); }
  if (lang) { sql += ' AND lang = ?'; params.push(lang); }
  sql += ' ORDER BY id';
  const list = db.prepare(sql).all(...params);
  res.json({ courses: list });
});

// ---------- 课程详情（公开，含章节目录与内容） ----------
app.get('/api/courses/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ message: '课程不存在' });
  const lessons = db.prepare('SELECT id, seq, title, subtitle, content FROM course_lessons WHERE course_id = ? ORDER BY seq').all(c.id);
  lessons.forEach(l => { try { l.content = JSON.parse(l.content || '{}'); } catch (e) { l.content = {}; } });
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

app.get('/api/quizzes', (req, res) => {
  const courseId = req.query.courseId;
  if (!courseId) return res.status(400).json({ message: '缺少课程ID' });
  const type = (req.query.type || '').toString();
  let rows;
  if (type) rows = db.prepare('SELECT id, type, question, prompt, options, answer, explain, seq FROM practice_quizzes WHERE course_id = ? AND type = ? ORDER BY seq').all(courseId, type);
  else rows = db.prepare('SELECT id, type, question, prompt, options, answer, explain, seq FROM practice_quizzes WHERE course_id = ? ORDER BY seq').all(courseId);
  const quizzes = rows.map(q => ({
    id: q.id, type: q.type, question: q.question, prompt: q.prompt,
    options: JSON.parse(q.options || '[]'), answer: q.answer, explain: q.explain, seq: q.seq
  }));
  res.json({ quizzes });
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

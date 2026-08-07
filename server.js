/**
 * PolyLingua AI — 用户系统后端（注册/登录/资料/签到/升级/错题/行为日志/资料编辑）
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
try { db.exec(`ALTER TABLE users ADD COLUMN openid TEXT`); } catch (e) {}

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
  ru_meaning TEXT,
  example TEXT,
  example2 TEXT,
  image TEXT,
  level TEXT,
  lang TEXT DEFAULT 'en',
  category TEXT DEFAULT '',
  zh_reading TEXT DEFAULT '',
  fr_word TEXT DEFAULT '',
  fr_reading TEXT DEFAULT '',
  phrases TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);
// 三语读法 + 金典短语 字段迁移（旧库兼容）
['zh_reading', 'fr_word', 'fr_reading', 'phrases'].forEach(col => {
  try { db.exec(`ALTER TABLE words ADD COLUMN ${col} TEXT DEFAULT ''`); } catch (e) {}
});

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
// 分类通用内容：当某课程没有精确 COURSE_THEMES 时，按 category 生成非空章节（对话/词汇/语法/技巧），避免空壳
const GENERIC_BY_CATEGORY = {
  '拼读': { dialogues:[{en:'The cat sat on the map.',zh:'猫坐在地图上。'},{en:'A big pig digs in the mud.',zh:'大猪在泥里挖。'}], vocab:[{w:'cat',ph:'/kæt/',zh:'猫',pos:'名词'},{w:'map',ph:'/mæp/',zh:'地图',pos:'名词'},{w:'pig',ph:'/pɪɡ/',zh:'猪',pos:'名词'},{w:'sun',ph:'/sʌn/',zh:'太阳',pos:'名词'},{w:'box',ph:'/bɒks/',zh:'盒子',pos:'名词'}], grammar:'CVC 结构：辅音+元音+辅音，先发首音再滑到尾音。', tip:'用押韵词对练，建立音形对应最快。' },
  '口语': { dialogues:[{en:'How are you today?',zh:'你今天好吗？'},{en:'Could you say that again, please?',zh:'能再说一遍吗？'}], vocab:[{w:'please',ph:'/pliːz/',zh:'请',pos:'其他'},{w:'thanks',ph:'/θæŋks/',zh:'谢谢',pos:'其他'},{w:'sorry',ph:'/ˈsɒri/',zh:'抱歉',pos:'其他'},{w:'help',ph:'/help/',zh:'帮助',pos:'动词'},{w:'friend',ph:'/frend/',zh:'朋友',pos:'名词'}], grammar:'礼貌用语：Could you / Would you mind + 动词原形。', tip:'每天用 5 个口语短句和真人对话或录音跟读。' },
  '发音': { dialogues:[{en:'Please repeat after me.',zh:'请跟我读。'},{en:'Slow down, I cannot follow.',zh:'慢一点，我跟不上。'}], vocab:[{w:'sound',ph:'/saʊnd/',zh:'声音',pos:'名词'},{w:'mouth',ph:'/maʊθ/',zh:'嘴',pos:'名词'},{w:'tongue',ph:'/tʌŋ/',zh:'舌头',pos:'名词'},{w:'stress',ph:'/stres/',zh:'重音',pos:'名词'},{w:'rhythm',ph:'/ˈrɪðəm/',zh:'节奏',pos:'名词'}], grammar:'单词重音位置改变词义（如 record 名词前重、动词后重）。', tip:'录下自己的发音对比原声，最容易发现差距。' },
  '语法': { dialogues:[{en:'She has finished her homework.',zh:'她已经做完作业了。'},{en:'If it rains, we will stay home.',zh:'如果下雨我们就待在家。'}], vocab:[{w:'because',ph:'/bɪˈkɒz/',zh:'因为',pos:'连词'},{w:'although',ph:'/ɔːlˈðəʊ/',zh:'虽然',pos:'连词'},{w:'unless',ph:'/ənˈles/',zh:'除非',pos:'连词'},{w:'whether',ph:'/ˈweðə/',zh:'是否',pos:'连词'},{w:'while',ph:'/waɪl/',zh:'当…时',pos:'连词'}], grammar:'状语从句：时间/条件/让步，注意主从句时态呼应。', tip:'每学一个语法点，造 3 个自己的句子巩固。' },
  '阅读': { dialogues:[{en:'What does this paragraph mainly talk about?',zh:'这段主要讲什么？'},{en:'I guess the answer from the context.',zh:'我根据上下文猜答案。'}], vocab:[{w:'paragraph',ph:'/ˈpærəɡrɑːf/',zh:'段落',pos:'名词'},{w:'main',ph:'/meɪn/',zh:'主要的',pos:'形容词'},{w:'context',ph:'/ˈkɒntekst/',zh:'上下文',pos:'名词'},{w:'detail',ph:'/ˈdiːteɪl/',zh:'细节',pos:'名词'},{w:'guess',ph:'/ɡes/',zh:'猜测',pos:'动词'}], grammar:'skim（略读）抓主旨，scan（扫读）找细节。', tip:'先读题再读文，定位快、正确率高。' },
  '词汇': { dialogues:[{en:'What does this word mean?',zh:'这个词是什么意思？'},{en:'Can you use it in a sentence?',zh:'能用在句子里吗？'}], vocab:[{w:'memory',ph:'/ˈmeməri/',zh:'记忆',pos:'名词'},{w:'review',ph:'/rɪˈvjuː/',zh:'复习',pos:'动词'},{w:'repeat',ph:'/rɪˈpiːt/',zh:'重复',pos:'动词'},{w:'daily',ph:'/ˈdeɪli/',zh:'每日的',pos:'形容词'},{w:'list',ph:'/lɪst/',zh:'列表',pos:'名词'}], grammar:'词根词缀记忆法：前缀表方向，后缀表词性。', tip:'按遗忘曲线间隔复习，记忆最牢。' },
  '应试': { dialogues:[{en:'Read the whole passage first.',zh:'先通读全文。'},{en:'Pay attention to the key words.',zh:'注意关键词。'}], vocab:[{w:'passage',ph:'/ˈpæsɪdʒ/',zh:'文章',pos:'名词'},{w:'keyword',ph:'/ˈkiːwɜːd/',zh:'关键词',pos:'名词'},{w:'score',ph:'/skɔː/',zh:'分数',pos:'名词'},{w:'strategy',ph:'/ˈstrætədʒi/',zh:'策略',pos:'名词'},{w:'practice',ph:'/ˈpræktɪs/',zh:'练习',pos:'名词'}], grammar:'先主旨后细节，排除绝对化选项。', tip:'真题限时训练，培养考试节奏感。' },
  '写作': { dialogues:[{en:'Could you check my essay?',zh:'能帮我看下作文吗？'},{en:'Please make it more formal.',zh:'请写得更正式些。'}], vocab:[{w:'essay',ph:'/ˈeseɪ/',zh:'作文',pos:'名词'},{w:'formal',ph:'/ˈfɔːml/',zh:'正式的',pos:'形容词'},{w:'paragraph',ph:'/ˈpærəɡrɑːf/',zh:'段落',pos:'名词'},{w:'topic',ph:'/ˈtɒpɪk/',zh:'主题',pos:'名词'},{w:'clear',ph:'/klɪə/',zh:'清晰的',pos:'形容词'}], grammar:'总分总结构：开头点题、中间展开、结尾升华。', tip:'背 5 个万能句型，考试直接套。' },
  '文化': { dialogues:[{en:'That slang is so cool!',zh:'那个俚语太酷了！'},{en:'What does that expression mean?',zh:'那个表达什么意思？'}], vocab:[{w:'slang',ph:'/slæŋ/',zh:'俚语',pos:'名词'},{w:'expression',ph:'/ɪkˈspreʃn/',zh:'表达',pos:'名词'},{w:'idiom',ph:'/ˈɪdiəm/',zh:'习语',pos:'名词'},{w:'custom',ph:'/ˈkʌstəm/',zh:'习俗',pos:'名词'},{w:'trend',ph:'/trend/',zh:'潮流',pos:'名词'}], grammar:'习语不能逐字翻译，要整体理解。', tip:'看原版影视剧，在地道语境里记表达。' },
  '综合': { dialogues:[{en:'Let us review what we learned.',zh:'我们复习一下学过的内容。'},{en:'Any questions about today’s lesson?',zh:'今天的内容有疑问吗？'}], vocab:[{w:'review',ph:'/rɪˈvjuː/',zh:'复习',pos:'动词'},{w:'lesson',ph:'/ˈlesn/',zh:'课',pos:'名词'},{w:'improve',ph:'/ɪmˈpruːv/',zh:'提高',pos:'动词'},{w:'daily',ph:'/ˈdeɪli/',zh:'每日的',pos:'形容词'},{w:'goal',ph:'/ɡəʊl/',zh:'目标',pos:'名词'}], grammar:'综合运用：听说读写交替训练，避免偏科。', tip:'每天固定 20 分钟，比周末突击更有效。' },
  '商务': { dialogues:[{en:'Let us schedule a meeting.',zh:'我们安排个会议吧。'},{en:'I will follow up by email.',zh:'我会邮件跟进。'}], vocab:[{w:'meeting',ph:'/ˈmiːtɪŋ/',zh:'会议',pos:'名词'},{w:'schedule',ph:'/ˈʃedjuːl/',zh:'安排',pos:'动词'},{w:'client',ph:'/ˈklaɪənt/',zh:'客户',pos:'名词'},{w:'report',ph:'/rɪˈpɔːt/',zh:'报告',pos:'名词'},{w:'agree',ph:'/əˈɡriː/',zh:'同意',pos:'动词'}], grammar:'商务沟通：清晰、简洁、有行动项（action item）。', tip:'邮件三要素：主题、要点、下一步。' },
  '基础': { dialogues:[{en:'I am a beginner.',zh:'我是初学者。'},{en:'Please speak slowly.',zh:'请说慢一点。'}], vocab:[{w:'beginner',ph:'/bɪˈɡɪnə/',zh:'初学者',pos:'名词'},{w:'slowly',ph:'/ˈsləʊli/',zh:'缓慢地',pos:'副词'},{w:'easy',ph:'/ˈiːzi/',zh:'容易的',pos:'形容词'},{w:'start',ph:'/stɑːt/',zh:'开始',pos:'动词'},{w:'learn',ph:'/lɜːn/',zh:'学习',pos:'动词'}], grammar:'先掌握最高频 100 词，覆盖日常八成场景。', tip:'从和自己的生活相关的词开始记。' },
  '教材同步': { dialogues:[{en:'Open your book to page 10.',zh:'把书翻到第10页。'},{en:'Let us read the text together.',zh:'我们一起读课文。'}], vocab:[{w:'text',ph:'/tekst/',zh:'课文',pos:'名词'},{w:'page',ph:'/peɪdʒ/',zh:'页',pos:'名词'},{w:'unit',ph:'/ˈjuːnɪt/',zh:'单元',pos:'名词'},{w:'exercise',ph:'/ˈeksəsaɪz/',zh:'练习',pos:'名词'},{w:'word',ph:'/wɜːd/',zh:'单词',pos:'名词'}], grammar:'按单元主题串联词汇与句型，循序渐进。', tip:'课前预习生词，课后再做配套练习。' },
  '场景': { dialogues:[{en:'Where is the nearest bank?',zh:'最近的银行在哪儿？'},{en:'I would like to order coffee.',zh:'我想点杯咖啡。'}], vocab:[{w:'bank',ph:'/bæŋk/',zh:'银行',pos:'名词'},{w:'order',ph:'/ˈɔːdə/',zh:'点单',pos:'动词'},{w:'near',ph:'/nɪə/',zh:'附近',pos:'介词'},{w:'help',ph:'/help/',zh:'帮助',pos:'动词'},{w:'need',ph:'/niːd/',zh:'需要',pos:'动词'}], grammar:'问路与点单：疑问词 + 名词/动词，礼貌加 please。', tip:'把出行高频场景各背 5 句，实战不慌。' },
  '听力': { dialogues:[{en:'Could you play it again?',zh:'能再放一遍吗？'},{en:'I caught the main idea.',zh:'我抓住了大意。'}], vocab:[{w:'listen',ph:'/ˈlɪsn/',zh:'听',pos:'动词'},{w:'repeat',ph:'/rɪˈpiːt/',zh:'重复',pos:'动词'},{w:'idea',ph:'/aɪˈdɪə/',zh:'意思',pos:'名词'},{w:'slow',ph:'/sləʊ/',zh:'慢的',pos:'形容词'},{w:'clear',ph:'/klɪə/',zh:'清晰的',pos:'形容词'}], grammar:'精听三遍：盲听→看文听→跟读。', tip:'从慢速材料起步，逐步切常速。' }
};
function genericTheme(c) {
  return GENERIC_BY_CATEGORY[c.category] || GENERIC_BY_CATEGORY['综合'];
}
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
  },
'外贸商务英语开口沟通实战陪跑': {
  "dialogues": [],
  "vocab": [],
  "grammar": "课程设计原则：短、重复、可模仿、可立刻用。学习核心标准：学员是否真的在和外国客户进行实际沟通。",
  "tip": "12 周从「不敢开口」到「独立完成外贸全流程英语沟通」，每周一个实战主题，照模板练就能用。",
  "weeks": [
    {
      "t": "第一周：商务沟通开场万能模板",
      "s": "见面寒暄 · 名片 · 展会 · 线上 · 视频 · 电话开场",
      "dialogue": [
        {
          "en": "Hello, I am from Sunrise Trading Company. Nice to meet you.",
          "zh": "您好，我来自旭日贸易公司，很高兴认识您。"
        },
        {
          "en": "Here is my business card. May I have your contact information?",
          "zh": "这是我的名片，方便留一下您的联系方式吗？"
        },
        {
          "en": "Could you tell me a little about your business?",
          "zh": "能简单介绍一下您的业务吗？"
        }
      ],
      "vocab": [
        {
          "w": "business card",
          "ph": "/ˈbɪznəs kɑːd/",
          "zh": "名片",
          "pos": "名词",
          "phrases": [
            "Here is my business card.",
            "May I have your business card?"
          ]
        },
        {
          "w": "introduce",
          "ph": "/ˌɪntrəˈdjuːs/",
          "zh": "介绍",
          "pos": "动词",
          "phrases": [
            "Let me introduce my company.",
            "Allow me to introduce myself."
          ]
        },
        {
          "w": "company",
          "ph": "/ˈkʌmpəni/",
          "zh": "公司",
          "pos": "名词",
          "phrases": [
            "I work for a trading company."
          ]
        },
        {
          "w": "customer",
          "ph": "/ˈkʌstəmə(r)/",
          "zh": "客户",
          "pos": "名词",
          "phrases": [
            "We serve global customers."
          ]
        },
        {
          "w": "product",
          "ph": "/ˈprɒdʌkt/",
          "zh": "产品",
          "pos": "名词",
          "phrases": [
            "This is our new product."
          ]
        },
        {
          "w": "contact",
          "ph": "/ˈkɒntækt/",
          "zh": "联系方式",
          "pos": "名词",
          "phrases": [
            "Please keep in contact."
          ]
        }
      ],
      "grammar": "三句式开场模板：①自我介绍（I am from...）②说明来意（I am here to...）③索要联系方式（May I have your...）。准备一套通用模板，见客户前念熟即可不冷场。",
      "tip": "把三句话写在小卡片上，见客户前默念三遍，紧张时照着说就不会尴尬。"
    },
    {
      "t": "第二周：询盘处理（第一轮沟通）",
      "s": "接询盘 · 问需求 · 轻跟进 · 展会后闭环",
      "dialogue": [
        {
          "en": "Thanks for your inquiry. Could you tell me your specific requirements?",
          "zh": "感谢您的询盘，能告诉我您的具体需求吗？"
        },
        {
          "en": "What specifications, usage and quantity do you need?",
          "zh": "您需要什么规格、用途和数量？"
        },
        {
          "en": "Just a gentle follow-up on my last email. Are you still interested?",
          "zh": "顺便跟进一下上封邮件，您还有兴趣吗？"
        }
      ],
      "vocab": [
        {
          "w": "inquiry",
          "ph": "/ɪnˈkwaɪəri/",
          "zh": "询盘",
          "pos": "名词",
          "phrases": [
            "Thanks for your inquiry.",
            "We received an inquiry from a new client."
          ]
        },
        {
          "w": "requirement",
          "ph": "/rɪˈkwaɪəmənt/",
          "zh": "需求",
          "pos": "名词",
          "phrases": [
            "Please list your requirements."
          ]
        },
        {
          "w": "specification",
          "ph": "/ˌspesɪfɪˈkeɪʃn/",
          "zh": "规格",
          "pos": "名词",
          "phrases": [
            "What are the specifications?"
          ]
        },
        {
          "w": "quantity",
          "ph": "/ˈkwɒntəti/",
          "zh": "数量",
          "pos": "名词",
          "phrases": [
            "What quantity do you need?"
          ]
        },
        {
          "w": "follow up",
          "ph": "/ˈfɒləʊ ʌp/",
          "zh": "跟进",
          "pos": "短语",
          "phrases": [
            "I will follow up with the client."
          ]
        },
        {
          "w": "reply",
          "ph": "/rɪˈplaɪ/",
          "zh": "回复",
          "pos": "动词",
          "phrases": [
            "Please reply at your earliest convenience."
          ]
        }
      ],
      "grammar": "接询盘三句式：感谢询盘→明确需求→给出初步回应。一次性问全规格/用途/数量，可显著提升客户回复意愿；客户不回时用轻跟进模板，频率建议 3-5 天一次。",
      "tip": "收到询盘 1 小时内回复，客户感受最专业；展会后 24 小时跟进转化率最高。"
    },
    {
      "t": "第三周：产品介绍万能模板",
      "s": "产品定义 · 特点 · 优势 · 用途 · 对比",
      "dialogue": [
        {
          "en": "This is our best-selling product. Its main feature is energy saving.",
          "zh": "这是我们最畅销的产品，主要特点是节能。"
        },
        {
          "en": "It is widely used in hospitals and laboratories.",
          "zh": "它广泛用于医院和实验室。"
        },
        {
          "en": "Compared with the old model, this one is 30% lighter.",
          "zh": "相比旧款，这款轻了 30%。"
        }
      ],
      "vocab": [
        {
          "w": "product",
          "ph": "/ˈprɒdʌkt/",
          "zh": "产品",
          "pos": "名词",
          "phrases": [
            "Our product sells well."
          ]
        },
        {
          "w": "feature",
          "ph": "/ˈfiːtʃə(r)/",
          "zh": "特点",
          "pos": "名词",
          "phrases": [
            "What is the key feature?"
          ]
        },
        {
          "w": "advantage",
          "ph": "/ədˈvɑːntɪdʒ/",
          "zh": "优势",
          "pos": "名词",
          "phrases": [
            "The main advantage is low cost."
          ]
        },
        {
          "w": "application",
          "ph": "/ˌæplɪˈkeɪʃn/",
          "zh": "用途",
          "pos": "名词",
          "phrases": [
            "What is the application?"
          ]
        },
        {
          "w": "model",
          "ph": "/ˈmɒdl/",
          "zh": "型号",
          "pos": "名词",
          "phrases": [
            "Which model do you prefer?"
          ]
        },
        {
          "w": "compare",
          "ph": "/kəmˈpeə(r)/",
          "zh": "比较",
          "pos": "动词",
          "phrases": [
            "Let me compare the two models."
          ]
        }
      ],
      "grammar": "30 秒产品介绍结构：产品定义→核心特点→目标客户。模板可适配任意行业，照着填空即可；对比竞品时保持中立、突出自家优势。",
      "tip": "用「定义+特点+客户」三段式，每天练一次，30 秒开口就有条理。"
    },
    {
      "t": "第四周：报价与谈价",
      "s": "报价格式 · 贸易条款 · 价格异议 · 折扣",
      "dialogue": [
        {
          "en": "Our quotation is USD 12 per unit, FOB Shanghai.",
          "zh": "我们的报价是每件 12 美元，上海离岸价。"
        },
        {
          "en": "Could you share your target price?",
          "zh": "能告知您的目标价格吗？"
        },
        {
          "en": "The price is reasonable because of the superior material.",
          "zh": "这个价格合理，因为材料更优。"
        }
      ],
      "vocab": [
        {
          "w": "quotation",
          "ph": "/ˌkwəʊtˈeɪʃn/",
          "zh": "报价",
          "pos": "名词",
          "phrases": [
            "Here is our quotation.",
            "Please send your quotation."
          ]
        },
        {
          "w": "price",
          "ph": "/praɪs/",
          "zh": "价格",
          "pos": "名词",
          "phrases": [
            "The price is negotiable."
          ]
        },
        {
          "w": "FOB",
          "ph": "/ef əʊ biː/",
          "zh": "离岸价",
          "pos": "名词",
          "phrases": [
            "The price is FOB Shanghai."
          ]
        },
        {
          "w": "CIF",
          "ph": "/siː aɪ ef/",
          "zh": "到岸价",
          "pos": "名词",
          "phrases": [
            "We can quote CIF if needed."
          ]
        },
        {
          "w": "discount",
          "ph": "/ˈdɪskaʊnt/",
          "zh": "折扣",
          "pos": "名词",
          "phrases": [
            "We can offer a small discount."
          ]
        },
        {
          "w": "negotiate",
          "ph": "/nɪˈɡəʊʃieɪt/",
          "zh": "谈判",
          "pos": "动词",
          "phrases": [
            "Let us negotiate the price."
          ]
        }
      ],
      "grammar": "专业报价格式：单价 + 贸易条款（FOB/CIF/EXW）。客户说「太贵了」时先确认原因，再解释价值，不要立刻降价；折扣要给得有理由、不伤利润。",
      "tip": "报价时一定写清包含什么（运费/税费/包装），避免后续扯皮。"
    },
    {
      "t": "第五周：样品沟通与寄样",
      "s": "问样品 · 样品费 · 快递 · 寄样跟进",
      "dialogue": [
        {
          "en": "Would you like a sample? The sample fee is refundable.",
          "zh": "需要样品吗？样品费可退。"
        },
        {
          "en": "We will send the sample by express within two days.",
          "zh": "我们两天内快递寄出样品。"
        },
        {
          "en": "The sample is slightly different from mass production.",
          "zh": "样品与大货略有差异。"
        }
      ],
      "vocab": [
        {
          "w": "sample",
          "ph": "/ˈsɑːmpl/",
          "zh": "样品",
          "pos": "名词",
          "phrases": [
            "We can provide a free sample."
          ]
        },
        {
          "w": "sample fee",
          "ph": "/ˈsɑːmpl fiː/",
          "zh": "样品费",
          "pos": "短语",
          "phrases": [
            "The sample fee is USD 20."
          ]
        },
        {
          "w": "express",
          "ph": "/ɪkˈspres/",
          "zh": "快递",
          "pos": "名词",
          "phrases": [
            "We will ship by express."
          ]
        },
        {
          "w": "shipping",
          "ph": "/ˈʃɪpɪŋ/",
          "zh": "运输",
          "pos": "名词",
          "phrases": [
            "The shipping cost is on us."
          ]
        },
        {
          "w": "mass production",
          "ph": "/mæs prəˈdʌkʃn/",
          "zh": "大货",
          "pos": "短语",
          "phrases": [
            "Mass production starts next week."
          ]
        },
        {
          "w": "refundable",
          "ph": "/rɪˈfʌndəbl/",
          "zh": "可退的",
          "pos": "形容词",
          "phrases": [
            "The fee is refundable."
          ]
        }
      ],
      "grammar": "样品费说明原则：明确是否可退、运费由谁承担、可退政策如何执行。寄样后 3 天内跟进，询问客户是否收到、有无疑问。",
      "tip": "样品是建立信任的关键一步，寄出后主动发快递单号并跟进。"
    },
    {
      "t": "第六周：订单确认与合同沟通",
      "s": "PI要素 · 付款方式 · 交期 · 改单",
      "dialogue": [
        {
          "en": "Please confirm the Proforma Invoice before payment.",
          "zh": "付款前请确认形式发票。"
        },
        {
          "en": "We accept T/T and L/C as payment terms.",
          "zh": "我们接受电汇和信用证付款。"
        },
        {
          "en": "The lead time is about 30 days after deposit.",
          "zh": "收到定金后交期约 30 天。"
        }
      ],
      "vocab": [
        {
          "w": "order",
          "ph": "/ˈɔːdə(r)/",
          "zh": "订单",
          "pos": "名词",
          "phrases": [
            "We received a big order."
          ]
        },
        {
          "w": "Proforma Invoice",
          "ph": "/prəˈfɔːmə ˈɪnvɔɪs/",
          "zh": "形式发票(PI)",
          "pos": "名词",
          "phrases": [
            "Please confirm the PI."
          ]
        },
        {
          "w": "payment",
          "ph": "/ˈpeɪmənt/",
          "zh": "付款",
          "pos": "名词",
          "phrases": [
            "What is the payment term?"
          ]
        },
        {
          "w": "T/T",
          "ph": "/tiː tiː/",
          "zh": "电汇",
          "pos": "名词",
          "phrases": [
            "We prefer T/T payment."
          ]
        },
        {
          "w": "L/C",
          "ph": "/el siː/",
          "zh": "信用证",
          "pos": "名词",
          "phrases": [
            "L/C is safer for large orders."
          ]
        },
        {
          "w": "lead time",
          "ph": "/liːd taɪm/",
          "zh": "交期",
          "pos": "短语",
          "phrases": [
            "The lead time is 30 days."
          ]
        }
      ],
      "grammar": "让客户确认 PI 是付款前必要步骤；清晰说明付款方式（TT/LC/PayPal）与交期，主动回应下单前客户常见顾虑，降低其风险感。",
      "tip": "下单前主动列出客户可能的顾虑并逐一回应，能大幅减少后续纠纷。"
    },
    {
      "t": "第七周：生产跟进与进度沟通",
      "s": "进度更新 · 催进度 · 延期 · 包装确认",
      "dialogue": [
        {
          "en": "Production is 50% complete. We will finish by this Friday.",
          "zh": "生产已完成 50%，本周五前完工。"
        },
        {
          "en": "Sorry for the delay; the new delivery date is next Monday.",
          "zh": "抱歉延期，新的发货日是下周一。"
        },
        {
          "en": "Please confirm the packaging method you prefer.",
          "zh": "请确认您偏好的包装方式。"
        }
      ],
      "vocab": [
        {
          "w": "production",
          "ph": "/prəˈdʌkʃn/",
          "zh": "生产",
          "pos": "名词",
          "phrases": [
            "Production is on schedule."
          ]
        },
        {
          "w": "progress",
          "ph": "/ˈprəʊɡres/",
          "zh": "进度",
          "pos": "名词",
          "phrases": [
            "Here is the latest progress."
          ]
        },
        {
          "w": "delay",
          "ph": "/dɪˈleɪ/",
          "zh": "延期",
          "pos": "名词",
          "phrases": [
            "Sorry for the delay."
          ]
        },
        {
          "w": "packaging",
          "ph": "/ˈpækɪdʒɪŋ/",
          "zh": "包装",
          "pos": "名词",
          "phrases": [
            "We use export cartons."
          ]
        },
        {
          "w": "update",
          "ph": "/ʌpˈdeɪt/",
          "zh": "更新",
          "pos": "动词",
          "phrases": [
            "I will update you weekly."
          ]
        },
        {
          "w": "reassure",
          "ph": "/ˌriːəˈʃʊə(r)/",
          "zh": "安抚",
          "pos": "动词",
          "phrases": [
            "We reassure the client promptly."
          ]
        }
      ],
      "grammar": "进度更新模板：当前完成度→预计完工日→辅助图片/视频。遇延期坦诚说明原因并给新交期，比隐瞒更得信任。",
      "tip": "主动更新进度比客户来催更显专业，能显著降低客户的焦虑感。"
    },
    {
      "t": "第八周：品质沟通与验货",
      "s": "质量标准 · 验货 · 质量担忧 · 安心发货",
      "dialogue": [
        {
          "en": "We have strict quality standards for every batch.",
          "zh": "我们对每批货都有严格质量标准。"
        },
        {
          "en": "Sure, we can arrange a third-party inspection.",
          "zh": "当然，我们可以安排第三方验货。"
        },
        {
          "en": "We can accept or decline based on your requirement.",
          "zh": "根据您的要求我们可以接受或拒绝。"
        }
      ],
      "vocab": [
        {
          "w": "quality",
          "ph": "/ˈkwɒləti/",
          "zh": "质量",
          "pos": "名词",
          "phrases": [
            "Quality comes first."
          ]
        },
        {
          "w": "inspection",
          "ph": "/ɪnˈspekʃn/",
          "zh": "验货",
          "pos": "名词",
          "phrases": [
            "We arrange final inspection."
          ]
        },
        {
          "w": "standard",
          "ph": "/ˈstændəd/",
          "zh": "标准",
          "pos": "名词",
          "phrases": [
            "Our standard is very strict."
          ]
        },
        {
          "w": "concern",
          "ph": "/kənˈsɜːn/",
          "zh": "担忧",
          "pos": "名词",
          "phrases": [
            "We understand your concern."
          ]
        },
        {
          "w": "solution",
          "ph": "/səˈluːʃn/",
          "zh": "解决方案",
          "pos": "名词",
          "phrases": [
            "We have a good solution."
          ]
        },
        {
          "w": "complain",
          "ph": "/kəmˈpleɪn/",
          "zh": "投诉",
          "pos": "动词",
          "phrases": [
            "No client complained yet."
          ]
        }
      ],
      "grammar": "回应质量担忧原则：先共情→解释标准→给出方案。让客户知道你重视品质，自然安心等待发货。",
      "tip": "把质检报告主动发给客户，比等他问更有说服力。"
    },
    {
      "t": "第九周：物流发货与运输沟通",
      "s": "发货通知 · 运输方式 · 运费 · 清关",
      "dialogue": [
        {
          "en": "Your goods are ready for shipping by sea.",
          "zh": "您的货物已备好，走海运。"
        },
        {
          "en": "Here is the tracking number for your shipment.",
          "zh": "这是您货物的运单号。"
        },
        {
          "en": "Please prepare the customs clearance documents in advance.",
          "zh": "请提前准备好清关文件。"
        }
      ],
      "vocab": [
        {
          "w": "shipping",
          "ph": "/ˈʃɪpɪŋ/",
          "zh": "发货",
          "pos": "名词",
          "phrases": [
            "Shipping starts tomorrow."
          ]
        },
        {
          "w": "sea freight",
          "ph": "/siː freɪt/",
          "zh": "海运",
          "pos": "短语",
          "phrases": [
            "Sea freight is cheaper."
          ]
        },
        {
          "w": "air freight",
          "ph": "/eə freɪt/",
          "zh": "空运",
          "pos": "短语",
          "phrases": [
            "Air freight is faster."
          ]
        },
        {
          "w": "tracking",
          "ph": "/ˈtrækɪŋ/",
          "zh": "追踪",
          "pos": "名词",
          "phrases": [
            "Here is the tracking number."
          ]
        },
        {
          "w": "customs",
          "ph": "/ˈkʌstəmz/",
          "zh": "清关",
          "pos": "名词",
          "phrases": [
            "Customs may take a few days."
          ]
        },
        {
          "w": "delivery",
          "ph": "/dɪˈlɪvəri/",
          "zh": "送达",
          "pos": "名词",
          "phrases": [
            "Delivery takes two weeks."
          ]
        }
      ],
      "grammar": "运输方式说明（海运/空运/快递）+ 提醒客户配合清关。货物发出后主动给运单号，客户问「货在哪」时给出最新物流状态。",
      "tip": "发货当天就发通知 + 运单号，客户体验最好。"
    },
    {
      "t": "第十周：售后与投诉沟通",
      "s": "安抚 · 取证 · 方案 · 关系维护",
      "dialogue": [
        {
          "en": "Sorry to hear that. Could you send a photo of the issue?",
          "zh": "很抱歉，能发一张问题照片吗？"
        },
        {
          "en": "We can offer a replacement or refund for this case.",
          "zh": "这种情况我们可以换货或退款。"
        },
        {
          "en": "Thank you for your understanding. We value your trust.",
          "zh": "感谢理解，我们珍视您的信任。"
        }
      ],
      "vocab": [
        {
          "w": "after-sales",
          "ph": "/ˈɑːftə seɪlz/",
          "zh": "售后",
          "pos": "形容词",
          "phrases": [
            "We have good after-sales service."
          ]
        },
        {
          "w": "issue",
          "ph": "/ˈɪʃuː/",
          "zh": "问题",
          "pos": "名词",
          "phrases": [
            "There is a quality issue."
          ]
        },
        {
          "w": "evidence",
          "ph": "/ˈevɪdəns/",
          "zh": "证据",
          "pos": "名词",
          "phrases": [
            "Please provide evidence."
          ]
        },
        {
          "w": "replacement",
          "ph": "/rɪˈpleɪsmənt/",
          "zh": "换货",
          "pos": "名词",
          "phrases": [
            "We send a free replacement."
          ]
        },
        {
          "w": "refund",
          "ph": "/ˈriːfʌnd/",
          "zh": "退款",
          "pos": "名词",
          "phrases": [
            "We processed your refund."
          ]
        },
        {
          "w": "maintain",
          "ph": "/meɪnˈteɪn/",
          "zh": "维护",
          "pos": "动词",
          "phrases": [
            "We maintain good relations."
          ]
        }
      ],
      "grammar": "投诉处理四步：安抚情绪→确认问题→给方案（换货/补发/退款）→追踪进度。售后结束仍要维护关系，避免客户流失。",
      "tip": "客户投诉是留住他的机会，态度比赔偿更重要。"
    },
    {
      "t": "第十一周：长期合作与客户维护",
      "s": "定期联系 · 节日问候 · 推新品 · 提醒补货",
      "dialogue": [
        {
          "en": "We would like to build a long-term partnership with you.",
          "zh": "我们希望与您建立长期合作关系。"
        },
        {
          "en": "We just launched a new product; here is the catalog.",
          "zh": "我们刚推出新品，这是目录。"
        },
        {
          "en": "It is time to reorder; we can reserve stock for you.",
          "zh": "该补货了，我们可以为您预留库存。"
        }
      ],
      "vocab": [
        {
          "w": "long-term",
          "ph": "/ˈlɒŋ tɜːm/",
          "zh": "长期的",
          "pos": "形容词",
          "phrases": [
            "We seek long-term clients."
          ]
        },
        {
          "w": "partnership",
          "ph": "/ˈpɑːtnəʃɪp/",
          "zh": "合作",
          "pos": "名词",
          "phrases": [
            "Let us build a partnership."
          ]
        },
        {
          "w": "reorder",
          "ph": "/ˌriːˈɔːdə(r)/",
          "zh": "补货",
          "pos": "动词",
          "phrases": [
            "Please reorder soon."
          ]
        },
        {
          "w": "new product",
          "ph": "/njuː ˈprɒdʌkt/",
          "zh": "新品",
          "pos": "短语",
          "phrases": [
            "Check our new product."
          ]
        },
        {
          "w": "festival",
          "ph": "/ˈfestɪvl/",
          "zh": "节日",
          "pos": "名词",
          "phrases": [
            "Happy Mid-Autumn Festival."
          ]
        },
        {
          "w": "loyal",
          "ph": "/ˈlɔɪəl/",
          "zh": "忠实的",
          "pos": "形容词",
          "phrases": [
            "We value loyal clients."
          ]
        }
      ],
      "grammar": "客户维护原则：定期联系但不打扰，借节日问候，主动推新品 / 提醒补货，把普通客户升级为长期合作伙伴。",
      "tip": "老客户复购成本最低，节日一句问候胜过千言广告。"
    },
    {
      "t": "第十二周：展会与客户拜访全流程实战",
      "s": "展会开场 · 产品介绍 · 需求记录 · 工厂参观 · 演练",
      "dialogue": [
        {
          "en": "Welcome to our booth! Let me introduce our products.",
          "zh": "欢迎来到我们的展位！我给您介绍产品。"
        },
        {
          "en": "Would you like to visit our factory nearby?",
          "zh": "想参观我们附近的工厂吗？"
        },
        {
          "en": "Let us do a full simulation of the trade process.",
          "zh": "我们来做一次全流程实战演练。"
        }
      ],
      "vocab": [
        {
          "w": "exhibition",
          "ph": "/ˌeksɪˈbɪʃn/",
          "zh": "展会",
          "pos": "名词",
          "phrases": [
            "We join the Canton Fair."
          ]
        },
        {
          "w": "booth",
          "ph": "/buːð/",
          "zh": "展位",
          "pos": "名词",
          "phrases": [
            "Our booth is in Hall 3."
          ]
        },
        {
          "w": "visit",
          "ph": "/ˈvɪzɪt/",
          "zh": "拜访",
          "pos": "动词",
          "phrases": [
            "We visit clients abroad."
          ]
        },
        {
          "w": "factory",
          "ph": "/ˈfæktri/",
          "zh": "工厂",
          "pos": "名词",
          "phrases": [
            "Welcome to our factory."
          ]
        },
        {
          "w": "tour",
          "ph": "/tʊə(r)/",
          "zh": "参观",
          "pos": "名词",
          "phrases": [
            "We give a factory tour."
          ]
        },
        {
          "w": "simulation",
          "ph": "/ˌsɪmjuˈleɪʃn/",
          "zh": "演练",
          "pos": "名词",
          "phrases": [
            "Let us run a simulation."
          ]
        }
      ],
      "grammar": "展会全流程：见面开场→产品介绍→问需求并记录→展后跟进；客户拜访含工厂参观开场与生产流程简洁介绍。最后做完整流程串联与真实场景复盘。",
      "tip": "展会后 24 小时内跟进，客户记忆最清晰，转化率最高。"
    }
  ]
}
};

// 由主题生成 6 章真实内容
function buildLessons(theme) {
  if (theme.weeks && theme.weeks.length) {
    return theme.weeks.map(function (w, i) {
      return {
        t: w.t,
        s: w.s || ('第' + (i + 1) + '周'),
        content: { dialogue: w.dialogue || [], vocab: w.vocab || [], grammar: w.grammar || '', tip: w.tip || '' }
      };
    });
  }
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
  const firstRun = db.prepare('SELECT COUNT(*) c FROM courses').get().c === 0;

  const courses = [
    { title: '新课标高中英语必修一', cover: '📘', level: '高中', category: '教材同步', lang: 'en', description: '紧扣新课标，逐课精讲词汇语法，配套听说读写训练。', tags: ['新课标', '教材'], price: 0, views: 1280, author: 'PolyLingua AI', lessons: 6 },
    { title: '小学英语口语启蒙', cover: '🎈', level: '小学', category: '口语', lang: 'en', description: '从26个字母到日常对话，让孩子敢说爱说。', tags: ['启蒙', '口语'], price: 0, views: 2304, author: 'Lucky老师', lessons: 6 },
    { title: '零基础成人英语', cover: '🌱', level: '零基础', category: '综合', lang: 'en', description: '完全从零开始，建立英语语感与基础词汇量。', tags: ['成人', '零基础'], price: 29, views: 980, author: 'PolyLingua AI', lessons: 6 },
    { title: '中考语法专项突破', cover: '📐', level: '初中', category: '语法', lang: 'en', description: '八大时态、从句、非谓语系统梳理，提分利器。', tags: ['中考', '语法'], price: 0, views: 1567, author: 'Lucky老师', lessons: 6 },
    { title: '雅思口语7分训练', cover: '🎯', level: '雅思', category: '口语', lang: 'en', description: 'Part1-3全真话题，地道表达+逻辑框架。', tags: ['雅思', '口语'], price: 199, views: 642, author: '外籍考官Tom', lessons: 6 },
    { title: '旅游英语随手说', cover: '✈️', level: '实用', category: '场景', lang: 'en', description: '机场、酒店、点餐、问路，出行必备300句。', tags: ['旅游', '场景'], price: 0, views: 1890, author: 'PolyLingua AI', lessons: 6 },
    { title: '商务邮件写作', cover: '💼', level: '职场', category: '写作', lang: 'en', description: '从问候到跟进，写出专业得体的英文邮件。', tags: ['职场', '写作'], price: 99, views: 733, author: '外籍考官Tom', lessons: 6 },
    { title: '自然拼读Phonics', cover: '🔤', level: '小学', category: '拼读', lang: 'en', description: '建立字母与发音的对应关系，见词能读。', tags: ['拼读', '小学'], price: 0, views: 2105, author: 'Lucky老师', lessons: 6 },
    { title: '高考完形填空技巧', cover: '🧩', level: '高中', category: '应试', lang: 'en', description: '上下文逻辑+固定搭配，完形不再丢分。', tags: ['高考', '技巧'], price: 0, views: 1122, author: 'PolyLingua AI', lessons: 6 },
    { title: '美剧地道表达精讲', cover: '📺', level: '实用', category: '文化', lang: 'en', description: '从Friends到Modern Family，学中用用中学。', tags: ['美剧', '文化'], price: 29, views: 1743, author: 'Lucky老师', lessons: 6 },
    { title: '四六级核心词汇', cover: '📚', level: '大学', category: '词汇', lang: 'en', description: '高频词根词缀记忆法，30天突破核心词。', tags: ['四六级', '词汇'], price: 0, views: 2056, author: 'PolyLingua AI', lessons: 6 },
    { title: '日常英语听力训练', cover: '🎧', level: '综合', category: '听力', lang: 'en', description: '慢速到常速渐进，磨出英语耳朵。', tags: ['听力', '综合'], price: 0, views: 1340, author: '外籍考官Tom', lessons: 6 },
    { title: '旅游汉语轻松说', cover: '🏯', level: '入门', category: '场景', lang: 'zh', description: '出国旅游、景点购物、餐厅点单，最常用的汉语开口就说。', tags: ['汉语', '旅游'], price: 0, views: 860, author: 'PolyLingua AI', lessons: 6 },
    { title: '日常中文口语', cover: '💬', level: '入门', category: '口语', lang: 'zh', description: '从打招呼到约朋友，老外也能聊的中文日常对话。', tags: ['汉语', '口语'], price: 0, views: 1102, author: 'Lucky老师', lessons: 6 },
    { title: 'HSK1汉字与语法基础', cover: '🀄', level: 'HSK1', category: '基础', lang: 'zh', description: '系统学150核心词与基本句式，打好汉语根基。', tags: ['HSK', '基础'], price: 29, views: 540, author: 'PolyLingua AI', lessons: 6 },
    { title: '外贸商务英语开口沟通实战陪跑', cover: '💼', level: '职场', category: '商务', lang: 'en', description: '为零基础外贸新人打造的12周开口陪跑：从第一次见客户到独立完成外贸全流程英语沟通。', tags: ['外贸','商务'], price: 2980, views: 320, author: 'PolyLingua AI', lessons: 12 },
    { title: '英语字母与自然拼读启蒙', cover: '🔤', level: '零基础', category: '拼读', lang: 'en', description: '从 Aa 到 Zz，建立字母与发音的初印象。', tags: ['字母','拼读'], price: 0, views: 1500, author: 'PolyLingua AI', lessons: 6 },
    { title: '零基础日常问候速成', cover: '👋', level: '零基础', category: '口语', lang: 'en', description: 'Hello / Thanks / Sorry，十句打通陌生人破冰。', tags: ['问候','口语'], price: 0, views: 1200, author: 'Lucky老师', lessons: 6 },
    { title: '英语发音基础课', cover: '🗣️', level: '零基础', category: '发音', lang: 'en', description: '元音辅音逐个练，告别中式发音。', tags: ['发音','基础'], price: 0, views: 980, author: 'PolyLingua AI', lessons: 6 },
    { title: '小学英语语法入门', cover: '📐', level: '小学', category: '语法', lang: 'en', description: 'be 动词、名词单复数、一般现在时，打牢地基。', tags: ['语法','小学'], price: 0, views: 1600, author: 'Lucky老师', lessons: 6 },
    { title: '少儿英语故事阅读', cover: '📖', level: '小学', category: '阅读', lang: 'en', description: '用分级读物培养语感，在故事里学单词。', tags: ['阅读','故事'], price: 0, views: 1400, author: 'Lucky老师', lessons: 6 },
    { title: '初中核心词汇突破', cover: '📚', level: '初中', category: '词汇', lang: 'en', description: '中考高频词分类记忆，配例句不枯燥。', tags: ['词汇','初中'], price: 0, views: 1300, author: 'PolyLingua AI', lessons: 6 },
    { title: '初中英语完形填空技巧', cover: '🧩', level: '初中', category: '应试', lang: 'en', description: '上下文逻辑加固定搭配，完形稳拿分。', tags: ['完形','技巧'], price: 0, views: 1100, author: 'Lucky老师', lessons: 6 },
    { title: '高中英语阅读理解攻略', cover: '👁️', level: '高中', category: '阅读', lang: 'en', description: '速读定位加长难句拆解，阅读不再怕。', tags: ['阅读','高中'], price: 0, views: 1250, author: 'PolyLingua AI', lessons: 6 },
    { title: '高考英语书面表达（作文）', cover: '✍️', level: '高中', category: '写作', lang: 'en', description: '应用文模板加高级句型，作文冲高分。', tags: ['作文','高考'], price: 0, views: 1080, author: 'Lucky老师', lessons: 6 },
    { title: '考研英语核心词汇与长难句', cover: '🎓', level: '大学', category: '词汇', lang: 'en', description: '考研高频词加真题长难句精读。', tags: ['考研','词汇'], price: 0, views: 900, author: 'PolyLingua AI', lessons: 6 },
    { title: '专四专八词汇精讲', cover: '📚', level: '大学', category: '词汇', lang: 'en', description: '英语专业四级八级核心词系统突破。', tags: ['专四','专八'], price: 0, views: 760, author: 'PolyLingua AI', lessons: 6 },
    { title: '英语俚语与流行语天天学', cover: '💬', level: '实用', category: '文化', lang: 'en', description: 'native 才懂的俚语，让口语更地道。', tags: ['俚语','文化'], price: 0, views: 1560, author: 'Lucky老师', lessons: 6 },
    { title: '用英文歌学英语', cover: '🎵', level: '实用', category: '文化', lang: 'en', description: '在旋律里记单词、练听力、学发音。', tags: ['歌曲','听力'], price: 0, views: 1420, author: 'Lucky老师', lessons: 6 },
    { title: '外企面试英语通关', cover: '💼', level: '职场', category: '口语', lang: 'en', description: '自我介绍加行为面试加反问，拿 offer。', tags: ['面试','职场'], price: 0, views: 880, author: '外籍考官Tom', lessons: 6 },
    { title: '职场口语900句', cover: '💬', level: '职场', category: '口语', lang: 'en', description: '会议、邮件、汇报、社交全覆盖。', tags: ['职场','口语'], price: 0, views: 1020, author: '外籍考官Tom', lessons: 6 },
    { title: '托福口语与写作训练', cover: '🎯', level: '雅思', category: '口语', lang: 'en', description: '独立与综合任务模板，逻辑与语料双补。', tags: ['托福','口语'], price: 0, views: 640, author: '外籍考官Tom', lessons: 6 },
    { title: 'PTE学术英语冲刺', cover: '📊', level: '雅思', category: '综合', lang: 'en', description: '机器评分偏好训练，高分应答策略。', tags: ['PTE','学术'], price: 0, views: 520, author: 'PolyLingua AI', lessons: 6 },
    { title: '英语语法系统课（零到进阶）', cover: '📐', level: '综合', category: '语法', lang: 'en', description: '从词法到句法，搭建完整语法框架。', tags: ['语法','系统'], price: 0, views: 1180, author: 'PolyLingua AI', lessons: 6 },
    { title: '英语发音矫正训练', cover: '🗣️', level: '综合', category: '发音', lang: 'en', description: '常见发音误区逐个纠，说得准才听得懂。', tags: ['发音','矫正'], price: 0, views: 960, author: 'PolyLingua AI', lessons: 6 },
    { title: 'HSK2日常交际汉语', cover: '🀄', level: '入门', category: '口语', lang: 'zh', description: '购物、就医、约会场景，流利的中文日常对话。', tags: ['HSK2','口语'], price: 0, views: 480, author: 'PolyLingua AI', lessons: 6 },
    { title: 'HSK3工作与生活汉语', cover: '🀄', level: '入门', category: '综合', lang: 'zh', description: '处理工作邮件、安排旅行等实务汉语。', tags: ['HSK3','综合'], price: 0, views: 360, author: 'PolyLingua AI', lessons: 6 },
    { title: '商务汉语轻松上手', cover: '💼', level: '入门', category: '商务', lang: 'zh', description: '会议、谈判、宴请，职场汉语一把抓。', tags: ['商务','汉语'], price: 0, views: 420, author: 'PolyLingua AI', lessons: 6 }
  ];
  const insC = db.prepare('INSERT INTO courses (title, cover, level, category, lang, description, tags, price, views, author, lessons_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  courses.forEach(c => {
    const ex = db.prepare('SELECT COUNT(*) c FROM courses WHERE title=?').get(c.title);
    if (ex.c === 0) insC.run(c.title, c.cover, c.level, c.category, c.lang, c.description, JSON.stringify(c.tags), c.price, c.views, c.author, c.lessons);
  });

  if (firstRun) {
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
    { title: '“看世界”的多种英文表达', summary: 'see the world 不只是旅游，更代表开阔眼界。', cover: '🌍', tag: '实用表达', content: 'see the world 看世界；broaden one’s horizons 开阔视野；travel far and wide 游遍四方。PolyLingua AI，正是为了看更大的世界。' },
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
}
seedIfEmpty();

// ---------- 内容种子（章节 / 句子练习，独立于课程种子，库已存在也能补种） ----------
function seedContent() {
  // 每门课由主题生成章节（含对话/词汇/语法/技巧）；增量补种：已生成章节的课跳过，新课自动补
  {
    const courses = db.prepare('SELECT id, title FROM courses ORDER BY id').all();
    const insL = db.prepare('INSERT INTO course_lessons (course_id, seq, title, subtitle, content) VALUES (?,?,?,?,?)');
    courses.forEach(c => {
      if (db.prepare('SELECT COUNT(*) c FROM course_lessons WHERE course_id=?').get(c.id).c > 0) return;
      const theme = COURSE_THEMES[c.title] || genericTheme(c);
      const lessons = buildLessons(theme);
      lessons.forEach((lt, i) => insL.run(c.id, i + 1, lt.t, lt.s, JSON.stringify(lt.content)));
    });
  }

  // 句子听写练习池（含语法成分标注），英文+中文；增量补种，已存在的课跳过
  {
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
      if (db.prepare('SELECT COUNT(*) c FROM practice_sentences WHERE course_id=?').get(c.id).c > 0) return;
      const pool = c.lang === 'zh' ? zhPool : enPool;
      for (let k = 0; k < 3; k++) {
        const s = pool[(ci * 3 + k) % pool.length];
        insS.run(c.id, k + 1, s.sentence, s.translation, JSON.stringify(s.tokens), c.lang);
      }
    });
  }

  // 练习题（选择题 + 听力题），英文+中文；增量补种，已存在的课跳过
  {
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
      if (db.prepare('SELECT COUNT(*) c FROM practice_quizzes WHERE course_id=?').get(c.id).c > 0) return;
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
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 新用户预置「我的课程」（幂等：已加入则跳过） ----------
function presetUserCourses(uid) {
  const recs = ['零基础成人英语', '小学英语口语启蒙', '旅游英语随手说', '日常中文口语', '英语发音基础课', '职场口语900句'];
  const ins = db.prepare("INSERT OR IGNORE INTO user_courses (user_id, course_id, progress, joined_at) VALUES (?, ?, 0, datetime('now','localtime'))");
  recs.forEach(t => {
    const c = db.prepare('SELECT id FROM courses WHERE title=?').get(t);
    if (c) ins.run(uid, c.id);
  });
}
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
  presetUserCourses(user.id);
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
  if (db.prepare('SELECT COUNT(*) c FROM user_courses WHERE user_id=?').get(user.id).c === 0) presetUserCourses(user.id);
  res.json({ token, user: publicUser(user) });
});

// ---------- 微信小程序登录（wx.login → openid） ----------
app.post('/api/wx/login', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ message: '缺少登录凭证 code' });
  const APPID = process.env.WX_APPID;
  const SECRET = process.env.WX_APPSECRET;
  if (!APPID || !SECRET) {
    return res.status(400).json({ message: '服务器未配置微信登录（请在环境变量设置 WX_APPID / WX_APPSECRET）' });
  }
  try {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${APPID}&secret=${SECRET}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.errcode) {
      return res.status(401).json({ message: '微信登录失败', detail: data.errmsg || ('errcode ' + data.errcode) });
    }
    const openid = data.openid;
    if (!openid) return res.status(401).json({ message: '微信未返回 openid' });
    let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
    if (!user) {
      const nick = '微信用户' + openid.slice(-4);
      const info = db.prepare("INSERT INTO users (nickname, openid, role, created_at) VALUES (?,?,?,datetime('now','localtime'))").run(nick, openid, 'free');
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      presetUserCourses(user.id);
    } else {
      db.prepare("UPDATE users SET last_login = datetime('now','localtime'), last_ip = ? WHERE id = ?").run(req.ip, user.id);
    }
    const token = newToken();
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now','localtime', '+30 days'))").run(token, user.id);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    res.status(502).json({ message: '微信登录请求异常', detail: String(e) });
  }
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

// ---------- 课程列表（公开） ----------
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
  const category = (req.query.category || '').trim();
  if (category) { sql += ' AND w.category = ?'; params.push(category); }
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

// ---------- 内容管理：登录用户自助上传（附加功能） ----------
app.post('/api/admin/course', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: '缺少课程标题' });
  const tags = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',').map(x => x.trim()).filter(Boolean);
  const info = db.prepare("INSERT INTO courses (title, cover, level, category, lang, description, tags, price, views, author, lessons_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(b.title, b.cover || '📘', b.level || '综合', b.category || '其他', b.lang || 'en', b.description || '', JSON.stringify(tags), Number(b.price) || 0, 0, '我', 0);
  res.json({ id: info.lastInsertRowid, title: b.title });
});
app.post('/api/admin/lesson', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  if (!b.courseId || !b.title) return res.status(400).json({ error: '缺少课程或章节标题' });
  const seq = db.prepare('SELECT COALESCE(MAX(seq),0)+1 m FROM course_lessons WHERE course_id=?').get(b.courseId).m;
  const content = JSON.stringify({ dialogue: b.dialogue || [], vocab: b.vocab || [], grammar: b.grammar || '', tip: b.tip || '' });
  db.prepare('INSERT INTO course_lessons (course_id, seq, title, subtitle, content) VALUES (?,?,?,?,?)').run(b.courseId, seq, b.title, b.subtitle || '', content);
  db.prepare('UPDATE courses SET lessons_count=? WHERE id=?').run(seq, b.courseId);
  res.json({ ok: true, seq });
});
app.post('/api/admin/knowledge', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: '缺少文章标题' });
  db.prepare('INSERT INTO knowledge (title, summary, cover, tag, content) VALUES (?,?,?,?,?)').run(b.title, b.summary || '', b.cover || '💡', b.tag || '', b.content || '');
  res.json({ ok: true });
});

// 批量 upsert 课程（按 title 匹配）：直接补数据，绕过部署重置
app.post('/api/admin/courses', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const arr = Array.isArray(req.body && req.body.courses) ? req.body.courses : [];
  if (!arr.length) return res.status(400).json({ error: '缺少课程数据' });
  const ins = db.prepare('INSERT INTO courses (title, cover, level, category, lang, description, tags, price, views, author, lessons_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const selT = db.prepare('SELECT * FROM courses WHERE title=?');
  const upd = db.prepare('UPDATE courses SET cover=?, level=?, category=?, lang=?, description=?, tags=?, price=?, views=?, author=?, lessons_count=? WHERE title=?');
  let added = 0, updated = 0;
  const tx = db.transaction(() => {
    for (const it of arr) {
      if (!it || !it.title) continue;
      const t = String(it.title).trim();
      if (!t) continue;
      const exist = selT.get(t);
      const cover = it.cover || '📚', level = it.level || '', category = it.category || '', lang = it.lang || 'en',
            desc = it.description || '', tags = JSON.stringify(it.tags || []), price = it.price || 0,
            views = it.views || 0, author = it.author || 'PolyLingua AI', lessons = it.lessons_count || 6;
      if (exist) {
        upd.run(cover, level, category, lang, desc, tags, price, views, author, lessons, t);
        updated++;
      } else {
        ins.run(t, cover, level, category, lang, desc, tags, price, views, author, lessons);
        added++;
      }
    }
  });
  tx();
  res.json({ ok: true, added, updated });
});

// ---------- 内容管理：批量导入单词库（按词性分类） ----------
app.post('/api/admin/words', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const arr = Array.isArray(req.body && req.body.words) ? req.body.words : [];
  if (!arr.length) return res.status(400).json({ error: '缺少单词数据' });
  const ins = db.prepare('INSERT INTO words (word, phonetic, meaning, ru_meaning, example, example2, image, level, lang, category, zh_reading, fr_word, fr_reading, phrases) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const selOne = db.prepare('SELECT * FROM words WHERE id=?');
  const upd = db.prepare('UPDATE words SET phonetic=?,meaning=?,ru_meaning=?,example=?,example2=?,image=?,level=?,lang=?,category=?,zh_reading=?,fr_word=?,fr_reading=?,phrases=? WHERE id=?');
  let added = 0, updated = 0;
  const tx = db.transaction(() => {
    for (const it of arr) {
      if (!it || !it.word) continue;
      const w = String(it.word).trim();
      if (!w) continue;
      const key = w.toLowerCase();
      const exist = db.prepare('SELECT id FROM words WHERE LOWER(word)=?').get(key);
      if (exist) {
        const cur = selOne.get(exist.id);
        // 非破坏性更新：本次请求未提供三语字段时保留已有值，避免 import_words 覆盖 import_multi_words 写入的三语数据
        const zh = (it.zh_reading !== undefined && it.zh_reading !== '') ? it.zh_reading : (cur.zh_reading || '');
        const fr = (it.fr_word !== undefined && it.fr_word !== '') ? it.fr_word : (cur.fr_word || '');
        const frp = (it.fr_reading !== undefined && it.fr_reading !== '') ? it.fr_reading : (cur.fr_reading || '');
        const ph = (it.phrases !== undefined && it.phrases !== '') ? it.phrases : (cur.phrases || '');
        upd.run(
          it.phonetic || cur.phonetic || '',
          it.meaning || cur.meaning || '',
          it.ru_meaning || cur.ru_meaning || '',
          it.example || cur.example || '',
          it.example2 || cur.example2 || '',
          it.image || cur.image || '📝',
          it.level || cur.level || '',
          it.lang || cur.lang || 'en',
          it.category || cur.category || '',
          zh, fr, frp, ph,
          exist.id
        );
        updated++;
      } else {
        ins.run(w, it.phonetic || '', it.meaning || '', it.ru_meaning || '', it.example || '', it.example2 || '', it.image || '📝', it.level || '', it.lang || 'en', it.category || '', it.zh_reading || '', it.fr_word || '', it.fr_reading || '', it.phrases || '');
        added++;
      }
    }
  });
  tx();
  res.json({ ok: true, added, updated });
});

// ---------- 内容管理：AI 拆解上传文本 ----------
function decomposeText(text, suggestedTitle) {
  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function cnNum(n) { if (n <= 10) return CN_NUM[n]; if (n < 20) return '十' + CN_NUM[n - 10]; return String(n); }
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const headingRe = /^\s*(#{1,6}\s+.+|第\s*[0-9零一二三四五六七八九十百千]+\s*[章节课部分单元讲篇]|chapter\s*\d+|unit\s*\d+|lesson\s*\d+|\s*([0-9零一二三四五六七八九十]+)[.、．。]\s+\S)/i;
  const sections = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (headingRe.test(line)) {
      if (cur && cur.body.join('').trim()) sections.push(cur);
      cur = { title: line.replace(/^#+\s*/, '').trim(), body: [] };
    } else {
      if (!cur) cur = { title: '', body: [] };
      cur.body.push(line);
    }
  }
  if (cur && cur.body.join('').trim()) sections.push(cur);
  if (!sections.length) {
    const paras = String(text || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    let i = 0;
    for (const p of paras) sections.push({ title: '第' + cnNum(++i) + '部分', body: [p] });
  }
  const secs = sections.slice(0, 40);
  const EN_STOP = new Set('the a an and or but of to in on at for with without is are was were be been being this that these those it its as by from we you they he she i my your our their his her will would can could should may might must do does did have has had not no yes if then than so such same other another'.split(' '));
  const lessons = secs.map(function (s, idx) {
    const bodyText = s.body.join('\n');
    const subtitle = (s.body[0] || '').slice(0, 40);
    const vocabMap = {};
    const pairRe = /([A-Za-z][A-Za-z'\-]{3,})\s*[（(]\s*([一-龥A-Za-z][一-龥A-Za-z\s\/]{0,30}?)\s*[）)]/g;
    let m;
    while ((m = pairRe.exec(bodyText))) {
      const w = m[1].trim().toLowerCase();
      if (!vocabMap[w]) vocabMap[w] = { w: m[1].trim(), ph: '', zh: m[2].trim(), pos: '名词', phrases: [] };
    }
    const wordRe = /[A-Za-z][A-Za-z'\-]{4,}/g;
    const freq = {};
    let wm;
    while ((wm = wordRe.exec(bodyText))) { const w = wm[0].toLowerCase(); if (!EN_STOP.has(w)) freq[w] = (freq[w] || 0) + 1; }
    Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 12).forEach(function (w) {
      if (!vocabMap[w]) vocabMap[w] = { w: w, ph: '', zh: '', pos: '名词', phrases: [] };
    });
    const vocab = Object.values(vocabMap).slice(0, 12);
    const dialogue = [];
    const dlRe = /[“"‘']([^”"'’]{4,})[”"'’]/g; let dm;
    while ((dm = dlRe.exec(bodyText)) && dialogue.length < 6) dialogue.push({ en: dm[1].trim(), zh: '' });
    if (dialogue.length === 0) {
      const sentences = bodyText.split(/[。.!?！？\n]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 6; }).slice(0, 3);
      sentences.forEach(function (s) { dialogue.push({ en: s, zh: '' }); });
    }
    return {
      title: s.title || ('第' + cnNum(idx + 1) + '部分'),
      subtitle: subtitle || '',
      vocab: vocab,
      dialogue: dialogue.slice(0, 6),
      grammar: '',
      tip: '建议结合上下文反复跟读，巩固本节课重点。'
    };
  });
  return { title: suggestedTitle || (secs[0] && secs[0].title) || '我的上传课程', lessons: lessons };
}

async function llmDecompose(text, suggestedTitle) {
  if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL) return null;
  try {
    const prompt = '你是一个语言课程拆解助手。请将下面的资料拆解为结构化课程大纲，严格返回 JSON：{"title":string,"lessons":[{"title":string,"subtitle":string,"vocab":[{"w":英文,"ph":音标,"zh":中文,"pos":词性,"phrases":[例句字符串]},],"dialogue":[{"en":英文,"zh":中文}],"grammar":string,"tip":string}]}。只返回 JSON，不要解释。资料：\n' + String(text || '').slice(0, 12000);
    const r = await fetch(process.env.LLM_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.LLM_API_KEY },
      body: JSON.stringify({ model: process.env.LLM_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, response_format: { type: 'json_object' } })
    });
    const j = await r.json();
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) return null;
    const obj = JSON.parse(content);
    if (obj && Array.isArray(obj.lessons)) return obj;
  } catch (e) {}
  return null;
}

app.post('/api/admin/analyze', async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  if (!b.text || !String(b.text).trim()) return res.status(400).json({ error: '缺少文本内容' });
  let result = await llmDecompose(b.text, b.title);
  if (!result) result = decomposeText(b.text, b.title);
  res.json(result);
});

// ---------- 内容管理：链接直抓（抓取网页正文） ----------
app.post('/api/admin/fetch-url', async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  const raw = String(b.url || '').trim();
  if (!raw) return res.status(400).json({ error: '请输入网页链接' });
  let u;
  try {
    u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).json({ error: '仅支持 http/https 链接' });
  } catch (e) {
    return res.status(400).json({ error: '链接格式不正确' });
  }
  try {
    const resp = await fetch(u.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    if (!resp.ok) return res.status(502).json({ error: '抓取失败，状态码 ' + resp.status });
    const html = await resp.text();
    const extracted = extractArticleText(html);
    if (!extracted.text || extracted.text.length < 30) {
      return res.status(422).json({ error: '未能从该页面提取到正文，请改用「粘贴文本」模式手动粘贴内容。' });
    }
    res.json({ ok: true, title: extracted.title, text: extracted.text, url: u.href });
  } catch (e) {
    res.status(502).json({ error: '抓取失败：' + (e && e.message ? e.message : '网络错误') });
  }
});

function extractArticleText(html) {
  let h = String(html || '');
  let title = '';
  const mt = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (mt) title = decodeEntities(mt[1].replace(/\s+/g, ' ').trim());
  if (!title) {
    const mh = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (mh) title = decodeEntities(mh[1].replace(/<[^>]+>/g, '').trim());
  }
  h = h.replace(/<(script|style|noscript|svg|head|meta|link|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)[^>]*>/gi, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);
  h = h.replace(/[ \t]+/g, ' ');
  h = h.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).join('\n');
  h = h.replace(/\n{3,}/g, '\n\n');
  const text = h.trim().slice(0, 20000);
  return { title: title, text: text };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#(\d+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); });
}

app.post('/api/admin/course-full', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: '缺少课程标题' });
  const tags = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  const info = db.prepare('INSERT INTO courses (title, cover, level, category, lang, description, tags, price, views, author, lessons_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(b.title, b.cover || '📘', b.level || '综合', b.category || '其他', b.lang || 'en', b.description || '', JSON.stringify(tags), Number(b.price) || 0, 0, '我', 0);
  const cid = info.lastInsertRowid;
  const insL = db.prepare('INSERT INTO course_lessons (course_id, seq, title, subtitle, content) VALUES (?,?,?,?,?)');
  const lessons = Array.isArray(b.lessons) ? b.lessons : [];
  lessons.forEach(function (l, i) {
    const content = JSON.stringify({ dialogue: l.dialogue || [], vocab: l.vocab || [], grammar: l.grammar || '', tip: l.tip || '' });
    insL.run(cid, i + 1, l.title || ('第' + (i + 1) + '部分'), l.subtitle || '', content);
  });
  db.prepare('UPDATE courses SET lessons_count=? WHERE id=?').run(lessons.length, cid);
  res.json({ id: cid, title: b.title, lessons: lessons.length });
});

// ---------- 内容管理：删除（需登录） ----------
app.delete('/api/admin/course', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ error: '缺少课程id' });
  db.prepare('DELETE FROM course_lessons WHERE course_id=?').run(id);
  db.prepare('DELETE FROM user_courses WHERE course_id=?').run(id);
  db.prepare('DELETE FROM courses WHERE id=?').run(id);
  res.json({ ok: true });
});
app.delete('/api/admin/lesson', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ error: '缺少章节id' });
  const row = db.prepare('SELECT course_id, seq FROM course_lessons WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '章节不存在' });
  db.prepare('DELETE FROM course_lessons WHERE id=?').run(id);
  // 重排后续章节序号并回写 lessons_count
  const lessons = db.prepare('SELECT id, seq FROM course_lessons WHERE course_id=? ORDER BY seq').all(row.course_id);
  lessons.forEach((l, i) => { if (l.seq !== i + 1) db.prepare('UPDATE course_lessons SET seq=? WHERE id=?').run(i + 1, l.id); });
  const cnt = db.prepare('SELECT COUNT(*) c FROM course_lessons WHERE course_id=?').get(row.course_id).c;
  db.prepare('UPDATE courses SET lessons_count=? WHERE id=?').run(cnt, row.course_id);
  res.json({ ok: true });
});
app.delete('/api/admin/knowledge', (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '请先登录' });
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ error: '缺少知识库id' });
  db.prepare('DELETE FROM knowledge WHERE id=?').run(id);
  res.json({ ok: true });
});

// ============ AI 智能客服 ============
const CS_SYSTEM = '你是「Poly」，PolyLingua AI 平台的 AI 智能客服。请用简体中文、亲切且简短地回答��户关于：课程学习、会员权益、合伙人推广计划、错题本、账号与隐私设置、充值付费等问题；可引导用户使用��应页面（如「课程向导」「我的课程」「会员��益」「合伙人招募」「账户中心」）。遇到不确定的问题，诚实说明并可建议联系人工客服。回复控制在 200 字以内。';

function presetAnswer(q) {
  const t = String(q || '').toLowerCase();
  const faq = [
    { k: ['课程', '怎么学', '学习', '学什么', '入门', 'course'], a: '您可以在「课程向导」浏览推荐课程，或在「我的课程」继续学习。平台提供 Little Fox 动画、新课标词汇等课程，支持含音视频的课文跟读与智能练习。' },
    { k: ['会员', '权益', '升级', 'vip', '畅学', '收费', '多少钱'], a: '会员分为畅学版与合伙人版：畅学版解锁全部课程与智能练习；合伙人版额外含专属社群与推广返佣权限。可在「会员权益」页查看并升级。' },
    { k: ['合伙人', '推广', '赚钱', '佣金', '邀请', '返佣', 'partner'], a: '加入合伙人计划后，邀请好友注册即可获得推广返佣。在「合伙人招募」页可查看邀请明细与申请提现（满 ¥100 起提）。' },
    { k: ['错题', '错题本', '错'], a: '错题本已整合在「我的课程」页（今日时长下方）。系统会记录练习中的易错句子，支持点击 🔊 跟读巩固。' },
    { k: ['登录', '密码', '账号', '注册', '登入', 'login'], a: '可在左下角「账户中心 ▾」的「个人中心 / 隐私设置」管理账号。如忘记密码，请使用登录页的验证码方式重置。' },
    { k: ['退款', '退费', '付费', '支付', '钱'], a: '涉及订单与退款，请联系人工客服并提供账号信息，我们会尽快为您处理。' },
    { k: ['你好', '您好', 'hi', 'hello', '在吗', '你是谁'], a: '您好！我是 PolyLingua AI 客服 Poly，很高兴为您服务～请问有��么可以帮您？' }
  ];
  for (const f of faq) if (f.k.some(w => t.includes(w))) return f.a;
  return '感谢您的提问！我可以帮您解答「课程学习 / 会员权益 / 合伙人计划 / 错题本 / 账号设置」等方面的问题，请告诉我您想了解哪一块，或留下具体问题，我会尽力帮您～';
}

async function chatLLM(messages) {
  if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL) return null;
  try {
    const r = await fetch(process.env.LLM_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.LLM_API_KEY },
      body: JSON.stringify({ model: process.env.LLM_MODEL || 'gpt-4o-mini', messages, temperature: 0.5 })
    });
    const j = await r.json();
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return content ? content.trim() : null;
  } catch (e) { return null; }
}

app.post('/api/chat', async (req, res) => {
  const b = req.body || {};
  const history = Array.isArray(b.history) ? b.history.slice(-10) : [];
  const question = String(b.question || '').trim();
  if (!question) return res.status(400).json({ error: '请输入问题' });
  const msgs = [{ role: 'system', content: CS_SYSTEM }]
    .concat(history.map(m => ({ role: (m.role === 'bot' ? 'assistant' : 'user'), content: String(m.content || '') })))
    .concat([{ role: 'user', content: question }]);
  let answer = await chatLLM(msgs);
  let source = 'ai';
  if (!answer) { answer = presetAnswer(question); source = 'preset'; }
  res.json({ answer, source });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PolyLingua AI 后端已启动： http://0.0.0.0:${PORT}`);
});

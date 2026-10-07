/**
 * 数据库模块 —— 双模式
 *  - Render 生产：环境变量 DATABASE_URL 存在 → Postgres（经 pgstore 同步适配器）
 *  - 本地开发：   无 DATABASE_URL → node:sqlite 文件库 data/kaquan.db
 * 两种模式对上层暴露完全相同的同步 API，切换对 server.js 透明。
 */
const path = require('path');
const fs = require('fs');
const PG_MODE = !!process.env.DATABASE_URL;

// ---------- 表结构（SQLite 语法，由 pg-worker 在 PG 模式下自动转换） ----------
const DDL_MAIN = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  intro TEXT DEFAULT '',
  description TEXT DEFAULT '',
  system TEXT DEFAULT '卡易信',            -- 发卡系统：卡易信 / 卡商云 / 卡速售
  friend_link TEXT DEFAULT '',
  status TEXT DEFAULT 'online',            -- online 上架 / offline 下架 / black 黑名单
  featured INTEGER DEFAULT 0,              -- 首页置顶
  sponsored INTEGER DEFAULT 0,             -- 赞助广告位
  crawl_enabled INTEGER DEFAULT 0,         -- 是否参与比价抓取
  crawl_status TEXT DEFAULT '',            -- 最近抓取状态：ok / fail / ''
  logo_color TEXT DEFAULT '#2b7fff',
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  intro TEXT DEFAULT '',
  system TEXT DEFAULT '卡易信',
  friend_link TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',           -- pending / approved / rejected
  reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,                      -- 广告文字
  tag TEXT DEFAULT '推荐',                 -- 左侧小标签
  link TEXT DEFAULT '#',
  enabled INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT DEFAULT '',
  url TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS crawl_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT,
  site_id INTEGER,
  site_name TEXT,
  ok INTEGER,                              -- 1 成功 / 0 失败
  msg TEXT DEFAULT '',
  item_count INTEGER DEFAULT 0,
  cost_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

const DDL_STATS = `
CREATE TABLE IF NOT EXISTS stats_daily (     -- 每日访问：pv 浏览量 / uv 独立访客
  day TEXT PRIMARY KEY,
  pv INTEGER DEFAULT 0,
  uv INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stats_visitors (  -- 独立访客去重（保留 7 天，定时清理）
  day TEXT,
  visitor TEXT,
  seen_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (day, visitor)
);
CREATE TABLE IF NOT EXISTS stats_total (     -- 累计总量（单行）
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pv INTEGER DEFAULT 0,
  uv INTEGER DEFAULT 0
);
`;

const ALTER_COLS_SITES = ['clicks INTEGER DEFAULT 0'];
const ALTER_COLS_LINKS = ['title TEXT DEFAULT \'\'', 'keywords TEXT DEFAULT \'\'', 'description TEXT DEFAULT \'\'', "status TEXT DEFAULT 'approved'"];

let db;

if (PG_MODE) {
  // ---------- Postgres 模式 ----------
  try {
    const pgstore = require('./pgstore');
    // 建表（已存在则跳过）+ 一次性从 SQLite 文件导入旧数据（仅当 PG 为空）
    const alters = [
      ...ALTER_COLS_SITES.map(c => `ALTER TABLE sites ADD COLUMN ${c};`),
      ...ALTER_COLS_LINKS.map(c => `ALTER TABLE links ADD COLUMN ${c};`),
    ].join('\n');
    const mig = pgstore.migrateSync(DDL_MAIN + '\n' + alters + '\n' + DDL_STATS);
    console.log('✅ Postgres 已连接', mig && mig.skipped ? `(${JSON.stringify(mig.skipped)})` : '(数据迁移完成)');
    pgstore.__pgMode = true;
    db = pgstore;
  } catch (e) {
    console.error('❌ Postgres 连接失败，自动回退 SQLite（网站可正常运行）:', (e && e.message) || e);
  }
}

if (!db) {
  // ---------- SQLite 模式（本地开发 / PG 失败兜底） ----------
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'kaquan.db'));
  db.exec(DDL_MAIN);
  for (const col of ALTER_COLS_SITES) { try { db.exec(`ALTER TABLE sites ADD COLUMN ${col};`); } catch (_) {} }
  for (const col of ALTER_COLS_LINKS) { try { db.exec(`ALTER TABLE links ADD COLUMN ${col};`); } catch (_) {} }
  db.exec(DDL_STATS);
}

// 历史数据兼容：存量友链视为已通过；清理示例假数据
try {
  db.exec("UPDATE links SET status='approved' WHERE status IS NULL OR status='';");
  db.exec("DELETE FROM links WHERE name IN ('示例博客','示例论坛','示例站点');");
} catch (_) {}

// 锚点友链（后台可编辑/删除；URL 已存在则不重复插入）
const ANCHOR_LINKS = [
  ['自动秒收录', 'http://www.92kdh.com/', '92K导航', '网址导航,自动收录,秒收录', '92K导航 - 免费自动秒收录网址导航，做上本站链接来访一次自动首位展示'],
  ['AT导航', 'https://www.atdh.cn/',
    'AT导航_收录网_免费收录网站_自动收录网_秒收录',
    'AT导航,收录网,站长导航网,网址导航系统,自动秒收录,自助收录网',
    'AT导航(www.atdh.cn)为您提供免费网站收录,以及网址大全库的建立，旨在为用户提供高效便捷的网址收录和查询服务，同时提供最全的优秀名站导航。'],
];
try {
  for (const [name, url, title, keywords, description] of ANCHOR_LINKS) {
    const exist = db.prepare('SELECT id FROM links WHERE url LIKE ?').get(`%${new URL(url).hostname.replace(/^www\./, '')}%`);
    if (!exist) {
      db.prepare("INSERT INTO links (name,url,enabled,status,title,keywords,description) VALUES (?,?,?,?,?,?,?)")
        .run(name, url, 1, 'approved', title, keywords, description);
    }
  }
} catch (_) {}

// 累计基数（仅首次初始化）
try {
  const hasTotal = db.prepare('SELECT COUNT(*) AS c FROM stats_total').get().c;
  if (!hasTotal) {
    db.prepare('INSERT INTO stats_total (id, pv, uv) VALUES (1, ?, ?)').run(68231, 18932);
  }
} catch (_) {}

// 历史站点点击量基数（仅对 0 点击站点生效）
db.prepare('UPDATE sites SET clicks = (id * 977 + 5861) % 9000 + 1200 WHERE clicks = 0').run();

// 清理 7 天前的访客去重记录
db.prepare("DELETE FROM stats_visitors WHERE day < datetime('now','-7 days','localtime')").run();

// ---------- 种子数据（仅当 sites 为空时） ----------
try {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
  if (!count) {
    const seedSite = db.prepare(`INSERT INTO sites
      (name, domain, intro, description, system, friend_link, featured, sponsored, crawl_enabled, logo_color, sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const demo = [
      ['馨悦权益', 'xy.kkam.cn', '影视会员 | 餐饮美食 | 红包封面 | 一站式货源平台，一手权益货源会员批发。', '主营共享号/话费电费充值/权益货源，低价批发影视会员、网盘会员、音乐会员、美团会员、饿了么会员、滴滴优惠券等。', '卡易信', '', 1, 1, 1, '#2b7fff', 0],
      ['权益数卡', 'vip.vxes.cn', '国内领先的数卡权益货源卡券批发采购源头终端渠道平台。', '覆盖餐饮代下、视频影音会员、美食餐饮优惠券、知识服务、网盘加速、商超卡券、话费油卡等，支持 API 对接。', '卡商云', '', 0, 0, 0, '#2b7fff', 0],
    ];
    for (const d of demo) seedSite.run(...d);

    db.prepare('INSERT INTO announcements (title, content) VALUES (?,?)').run(
      '欢迎使用卡券货源导航 - 免责声明',
      '本站为第三方发卡站点导航与比价工具，仅收录展示第三方公开网站信息。本站不出售任何商品、不提供下单/支付/卡密发货服务，所有交易行为均发生在第三方网站，与本站无关。请自行甄别站点可靠性，交易风险自负。'
    );

    db.prepare('INSERT INTO banners (text, tag, link, sort) VALUES (?,?,?,?)')
      .run('ChatGPT Plus 会员限时特惠 ¥111，充值秒到账', '优惠券', '#/sites', 1);
    db.prepare('INSERT INTO banners (text, tag, link, sort) VALUES (?,?,?,?)')
      .run('视频会员直充 5 折起，支持批量采购', '推广', '#/sites', 2);
  }
} catch (_) {}

module.exports = db;

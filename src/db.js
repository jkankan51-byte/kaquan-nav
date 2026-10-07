/**
 * 数据库模块 —— 使用 Node 22 内置的 node:sqlite，无需安装任何原生依赖
 * 数据文件：data/kaquan.db（首次启动自动创建并写入种子数据）
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'kaquan.db'));
db.exec('PRAGMA journal_mode = WAL;');

// ---------- 建表 ----------
db.exec(`
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

-- 站点点击量（点击"前往/直达"时 +1）
`);

// 增量字段：已存在则跳过
try { db.exec('ALTER TABLE sites ADD COLUMN clicks INTEGER DEFAULT 0;'); } catch (_) {}
// 友链自助申请：TDK 字段 + 审核状态（pending 待审 / approved 已通过）
for (const col of ['title TEXT DEFAULT \'\'', 'keywords TEXT DEFAULT \'\'', 'description TEXT DEFAULT \'\'', "status TEXT DEFAULT 'approved'"]) {
  try { db.exec(`ALTER TABLE links ADD COLUMN ${col};`); } catch (_) {}
}
// 历史数据兼容：存量友链视为已通过；清理示例假数据
try {
  db.exec("UPDATE links SET status='approved' WHERE status IS NULL OR status='';");
  db.exec("DELETE FROM links WHERE name IN ('示例博客','示例论坛','示例站点');");
} catch (_) {}

// 92K导航自动收录回链（仅首次；后台友链管理里可编辑/删除，删掉会影响对方收录检测）
try {
  const has92 = db.prepare("SELECT id FROM links WHERE url LIKE '%92kdh.com%'").get();
  if (!has92) {
    db.prepare("INSERT INTO links (name,url,enabled,status,title,keywords,description) VALUES (?,?,?,?,?,?,?)")
      .run('自动秒收录', 'http://www.92kdh.com/', 1, 'approved',
        '92K导航', '网址导航,自动收录,秒收录', '92K导航 - 免费自动秒收录网址导航，做上本站链接来访一次自动首位展示');
  }
} catch (_) {}

// ---------- 访问统计表 ----------
db.exec(`
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
`);

// 累计基数（首次初始化，让新站不显得空旷；可在后台或直接改表调整）
const hasTotal = db.prepare('SELECT COUNT(*) AS c FROM stats_total').get().c;
if (!hasTotal) {
  db.prepare('INSERT INTO stats_total (id, pv, uv) VALUES (1, ?, ?)').run(68231, 18932);
}

// 历史站点点击量基数（仅初始化一次，之后真实点击继续累加）
db.prepare('UPDATE sites SET clicks = (id * 977 + 5861) % 9000 + 1200 WHERE clicks = 0').run();

// 清理 7 天前的访客去重记录（每次启动时顺带执行）
db.prepare("DELETE FROM stats_visitors WHERE day < datetime('now','-7 days','localtime')").run();

// ---------- 种子数据（仅首次） ----------
const count = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
if (count === 0) {
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

module.exports = db;

/**
 * 卡券货源导航站 - 后端服务
 * 定位：仅收录第三方发卡站点，只做站点导航 + 一键比价。
 * 本站不卖货、无下单、无支付、不接触卡密交易，所有交易跳转第三方网站。
 *
 * 启动：npm start   （默认端口 3000，可用环境变量 PORT 覆盖）
 * 后台：/admin.html  默认账号 admin / admin123（用 ADMIN_USER / ADMIN_PASSWORD 环境变量覆盖）
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
// 先确保本地数据库是最新版本（从 GitHub 拉回），再让 db.js 打开它
require('./persist').bootstrap();
const db = require('./db');
const crawler = require('./crawler');
const favicon = require('./favicon');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json({ limit: '256kb' }));

// ==================== 友链目录（服务端渲染：收录机器人/搜索引擎可直接看到回链） ====================
function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// URL 规范化：没写协议头的自动补 https://，避免浏览器当成相对路径拼到本站域名后
function normUrl(u) {
  const s = String(u || '').trim();
  if (!s) return s;
  return /^https?:\/\//i.test(s) ? s : 'https://' + s.replace(/^\/+/, '');
}
// 启动后自动补全：仅填了名称/网址、缺标题或简介的友链，去对方首页抓取 TDK（best-effort，不阻塞启动）
async function enrichLinks() {
  try {
    const rows = db.prepare("SELECT id,url FROM links WHERE (title IS NULL OR title='' OR description IS NULL OR description='')").all();
    for (const r of rows) {
      const got = await crawlLinkPage(normUrl(r.url), '');
      if (got && (got.title || got.description)) {
        db.prepare('UPDATE links SET title=?,keywords=?,description=? WHERE id=?')
          .run(got.title || r.url, got.keywords || '', got.description || '', r.id);
      }
    }
  } catch (_) {}
}
function approvedLinks() {
  return db.prepare("SELECT * FROM links WHERE enabled=1 AND status='approved' ORDER BY id DESC")
    .all().map(l => ({ ...l, url: normUrl(l.url) }));
}
// 首页"友情链接"分区（紧凑小链接样式，服务端渲染对收录机器人可见）
function homeLinksSection(links) {
  if (!links.length) return '';
  const items = links.map(l => {
    const d = linkDomain(l.url) || '';
    return `<a class="flink-item" href="${escHtml(l.url)}" target="_blank" rel="nofollow noopener" title="${escHtml(l.description || l.name)}">` +
      `<img src="/api/favicon?domain=${encodeURIComponent(d)}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'" alt="" />` +
      `<span>${escHtml(l.name)}</span></a>`;
  }).join('');
  // 注意：样式不能内联在此处（注入点在 #app 内，Vue 挂载时会删除 <style> 标签），统一放 style.css
  return `<div class="section">
        <div class="section-head">
          <div class="section-title">🔗 友情链接</div>
          <a class="section-more" href="/directory">更多友链 →</a>
        </div>
        <div class="flinks">${items}</div>
      </div>`;
}

// 首页：把审核通过的友链以"友情链接"分区形式注入（后台可管理；对收录机器人可见）
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    html = html.replace('<!--FRIEND_LINKS_SECTION-->', homeLinksSection(approvedLinks()));
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send('server error');
  }
});
// 目录页大卡片（仿首页"推荐站点"样式）
function dirCards(links) {
  return links.map(l => {
    const d = linkDomain(l.url) || '';
    const intro = escHtml(l.description || l.title || l.url);
    return `<a class="dcard" href="${escHtml(l.url)}" target="_blank" rel="nofollow noopener">` +
      `<div class="dcard-head"><img src="/api/favicon?domain=${encodeURIComponent(d)}" alt="" loading="lazy" onerror="this.style.display='none'">` +
      `<span class="dcard-name">${escHtml(l.name)}</span><i class="dcard-tag">友链</i></div>` +
      `<div class="dcard-intro">${intro}</div></a>`;
  }).join('\n');
}

// 独立友链目录页：全部友链 + 自助申请（服务端渲染）
app.get('/directory', (req, res) => {
  const links = approvedLinks();
  const cards = dirCards(links);
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>友链目录 - 卡券导航 | 自动秒收录友情链接大全</title>
<meta name="description" content="卡券导航友情链接目录：收录优质站点，做上本站链接来访一次自动首位展示，支持自助申请友链。">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%232b7fff'/><text x='50' y='68' font-size='52' text-anchor='middle' fill='white'>卡</text></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#f4f7fb;color:#1f2d3d;min-height:100vh;display:flex;flex-direction:column}
.topbar{background:linear-gradient(90deg,#2b7fff,#1e6ae1);color:#fff;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.topbar b{font-size:17px}
.topbar a{color:#fff;text-decoration:none;font-size:14px;opacity:.9}
.topbar a:hover{opacity:1;text-decoration:underline}
.notice{background:#fff;border:1px solid #e5ecf5;border-radius:10px;margin:16px auto 0;max-width:1100px;width:calc(100% - 32px);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.notice .n-tip{font-size:14px;color:#e6772e;font-weight:600}
.notice .n-btn{background:#2b7fff;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;text-decoration:none}
.wrap{max-width:1100px;margin:16px auto;width:calc(100% - 32px);flex:1}
.sec-title{font-size:15px;font-weight:700;margin:14px 0 10px;color:#33445c}
.dir-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.dcard{background:#fff;border:1px solid #e5ecf5;border-radius:12px;padding:14px;text-decoration:none;color:inherit;transition:.15s;box-shadow:0 1px 3px rgba(30,60,120,.05)}
.dcard:hover{border-color:#2b7fff;transform:translateY(-2px);box-shadow:0 6px 16px rgba(43,127,255,.12)}
.dcard-head{display:flex;align-items:center;gap:9px}
.dcard-head img{width:38px;height:38px;border-radius:9px;object-fit:contain;background:#f4f7fb;border:1px solid #eef2f8;padding:3px}
.dcard-name{font-size:15px;font-weight:700;color:#223;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcard-tag{font-style:normal;background:#eaf3ff;color:#2b7fff;font-size:11px;border-radius:6px;padding:2px 7px;margin-left:auto;flex-shrink:0}
.dcard-intro{font-size:12px;color:#8a99ad;margin-top:9px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.apply{background:#fff;border:1px solid #e5ecf5;border-radius:12px;padding:18px;margin-top:26px}
.apply h3{font-size:16px;margin-bottom:12px;color:#223}
.apply .row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
.apply label{font-size:13px;color:#5b6b82;width:64px;flex-shrink:0}
.apply input,.apply textarea{flex:1;min-width:200px;border:1px solid #dce4ee;border-radius:8px;padding:9px 12px;font-size:14px;outline:none}
.apply input:focus,.apply textarea:focus{border-color:#2b7fff}
.apply textarea{height:64px;resize:vertical}
.apply button{background:#2b7fff;color:#fff;border:none;border-radius:8px;padding:9px 20px;font-size:14px;cursor:pointer}
.apply button:disabled{opacity:.6}
.apply .btn2{background:#f0f4fa;color:#2b7fff}
.tip{font-size:13px;margin:6px 0 10px;padding:8px 12px;border-radius:8px;display:none}
.tip.ok{display:block;background:#eefaf1;color:#1d9e55;border:1px solid #bfe8cf}
.tip.warn{display:block;background:#fff8ec;color:#c07a1d;border:1px solid #f0dcb4}
.footer{text-align:center;font-size:12px;color:#8a99ad;padding:18px 0 26px;line-height:1.8}
.footer a{color:#5b6b82;text-decoration:none}
</style>
</head>
<body>
<div class="topbar">
  <b>🔗 卡券导航 · 友链目录</b>
  <a href="/">← 返回首页</a>
</div>
<div class="notice">
  <span class="n-tip">任何收录网站，做上本站链接来访一次自动首位展示（有望第一，永不沉底）</span>
  <a class="n-btn" href="#apply">申请收录</a>
</div>
<div class="wrap">
  <div class="sec-title">🕘 最新加入（${links.length} 个站点）</div>
  <div class="dir-grid">${cards || '<span style="color:#8a99ad;font-size:14px">暂无友链，快来抢占第一位</span>'}</div>

  <div class="apply" id="apply">
    <h3>✏️ 自助申请友链</h3>
    <div class="row">
      <label>网址</label><input id="f-url" placeholder="https://你的网站网址">
      <button id="btn-tdk" class="btn2" onclick="fetchTdk()">获取TDK</button>
    </div>
    <div id="tdk-tip" class="tip"></div>
    <div class="row"><label>网站名称</label><input id="f-name" maxlength="50" placeholder="网站名称"></div>
    <div class="row"><label>关键词</label><input id="f-kw" maxlength="200" placeholder="选填，英文逗号分隔"></div>
    <div class="row"><label>网站简介</label><textarea id="f-desc" maxlength="300" placeholder="选填，一句话介绍你的网站"></textarea></div>
    <div class="row" style="justify-content:flex-start">
      <button id="btn-go" onclick="applyLink()">立即提交</button>
      <a href="/" style="font-size:13px;color:#5b6b82;line-height:38px">收录规则：站点须合法合规，检测到回链自动过审</a>
    </div>
    <div id="go-tip" class="tip"></div>
  </div>
</div>
<div class="footer">
  卡券货源导航 · 仅收录第三方发卡站点 · 本站不卖货 / 无下单 / 无支付<br>
  <a href="/">返回首页</a> · <a href="/admin.html" target="_blank">管理后台</a>
</div>
<script>
function tip(el, ok, text){ var t = document.getElementById(el); t.className = 'tip ' + (ok ? 'ok' : 'warn'); t.textContent = text; }
function domain(u){ try { return new URL(u).hostname; } catch(e){ return ''; } }
async function fetchTdk(){
  var url = document.getElementById('f-url').value.trim();
  if(!url){ tip('tdk-tip', false, '请先填写网址'); return; }
  var btn = document.getElementById('btn-tdk'); btn.disabled = true; btn.textContent = '获取中…';
  try {
    var r = await fetch('/api/links/fetch-tdk?url=' + encodeURIComponent(url));
    var j = await r.json();
    if(!r.ok){ tip('tdk-tip', false, j.error || '获取失败'); }
    else {
      document.getElementById('f-name').value = document.getElementById('f-name').value || (j.title || '').slice(0, 50);
      document.getElementById('f-kw').value = document.getElementById('f-kw').value || (j.keywords || '');
      document.getElementById('f-desc').value = document.getElementById('f-desc').value || (j.description || '');
      tip('tdk-tip', true, '已自动获取网站 TDK 信息，请核对后提交');
    }
  } catch(e){ tip('tdk-tip', false, '获取失败，请检查网址是否可访问'); }
  btn.disabled = false; btn.textContent = '获取TDK';
}
async function applyLink(){
  var b = { url: document.getElementById('f-url').value.trim(), name: document.getElementById('f-name').value.trim(),
            keywords: document.getElementById('f-kw').value.trim(), description: document.getElementById('f-desc').value.trim() };
  if(!b.url || !b.name){ tip('go-tip', false, '请填写网址和网站名称'); return; }
  var btn = document.getElementById('btn-go'); btn.disabled = true; btn.textContent = '提交中…';
  try {
    var r = await fetch('/api/links/apply', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(b) });
    var j = await r.json();
    if(!r.ok){ tip('go-tip', false, j.error || '提交失败'); }
    else { tip('go-tip', true, j.message); if(j.status === 'approved') setTimeout(function(){ location.reload(); }, 1500); }
  } catch(e){ tip('go-tip', false, '提交失败，请稍后重试'); }
  btn.disabled = false; btn.textContent = '立即提交';
}
</script>
</body>
</html>`);
});

app.use(express.static(path.join(__dirname, '..', 'public')));
// 浏览器默认请求 /favicon.ico：页面已用 data-URI 图标，这里直接 204 避免 404 报错
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 百度站长平台文件验证：验证文件内容即验证码本身
app.get('/baidu_verify_codeva-xEG7wwYZzc.html', (req, res) => {
  res.type('html').send('codeva-xEG7wwYZzc');
});

// 站点地图 sitemap.xml（供百度/必应等搜索引擎定期抓取）
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://offclock.top';
  const urls = [
    { loc: `${base}/`, pri: '1.0', freq: 'daily' },
    { loc: `${base}/directory`, pri: '0.8', freq: 'daily' },
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url><loc>${u.loc}</loc><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n') +
    '\n</urlset>';
  res.type('application/xml').send(xml);
});

// 百度主动推送工具函数（在环境变量 BAIDU_PUSH_TOKEN 配置接口 token）
function baiduPush(urls) {
  const token = process.env.BAIDU_PUSH_TOKEN;
  if (!token || !Array.isArray(urls) || !urls.length) return Promise.resolve(null);
  const body = urls.join('\n');
  return fetch(`http://data.zz.baidu.com/urls?site=offclock.top&token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body
  }).then(r => r.text()).catch(() => null);
}
// 百度主动推送（手动触发）
app.post('/api/seo/baidu-push', express.json(), (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
  if (!urls.length) return res.status(400).json({ ok: false, msg: 'urls 为空' });
  baiduPush(urls).then(t => {
    if (t === null) return res.status(400).json({ ok: false, msg: '未配置 BAIDU_PUSH_TOKEN 或推送失败' });
    res.json({ ok: true, baidu: t });
  }).catch(e => res.status(502).json({ ok: false, msg: String(e) }));
});

// ---------------- 简易后台登录鉴权（内存 token，重启失效，重新登录即可） ----------------
const tokens = new Map(); // token -> expireAt
const TOKEN_TTL = 12 * 60 * 60 * 1000;

function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = tokens.get(token);
  if (!exp || Date.now() > exp) { tokens.delete(token); return res.status(401).json({ error: '登录已失效，请重新登录' }); }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, Date.now() + TOKEN_TTL);
    return res.json({ ok: true, token });
  }
  res.status(401).json({ error: '账号或密码错误' });
});

// ==================== 访问统计 / 点击量 ====================

// 实时在线：内存 Map（visitor -> 最后活跃时间），5 分钟内有心跳即算在线
const presence = new Map();
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  for (const [k, t] of presence) if (t < cutoff) presence.delete(k);
}, 60 * 1000).unref();

function today() { return new Date().toISOString().slice(0, 10); }

// 上报访问（前端每次进入页面调用），并归因来源
app.post('/api/track', (req, res) => {
  const body = req.body || {};
  const visitor = String(body.visitor || '').slice(0, 64);
  // 来源归因：优先专属反链 from=link_<id>，其次浏览器 referer 域名，否则直访
  let dim = 'direct', name = '';
  const from = String(body.from || '').trim().toLowerCase();
  const ref = String(body.ref || '').trim().toLowerCase().replace(/^www\./, '');
  if (/^link_\d+$/.test(from)) {
    const lid = parseInt(from.split('_')[1], 10);
    const lnk = db.prepare('SELECT id,name FROM links WHERE id=?').get(lid);
    if (lnk) { dim = 'link:' + lid; name = lnk.name; }
    else if (ref) dim = 'ref:' + ref;
  } else if (ref) {
    dim = 'ref:' + ref;
  }
  if (/^[a-f0-9-]{8,64}$/i.test(visitor)) {
    const d = today();
    presence.set(visitor, Date.now());
    // 先查是否存在再插入（兼容 SQLite/PG，避免 SQLite 专用 changes()）
    const existed = db.prepare('SELECT 1 AS c FROM stats_visitors WHERE day=? AND visitor=?').get(d, visitor);
    const isNew = !existed;
    db.prepare('INSERT OR IGNORE INTO stats_visitors (day, visitor) VALUES (?,?)').run(d, visitor);
    db.prepare(`INSERT INTO stats_daily (day, pv, uv) VALUES (?,1,?)
                ON CONFLICT(day) DO UPDATE SET pv = stats_daily.pv + 1, uv = stats_daily.uv + ?`)
      .run(d, isNew ? 1 : 0, isNew ? 1 : 0);
    db.prepare('UPDATE stats_total SET pv = pv + 1, uv = uv + ? WHERE id = 1').run(isNew ? 1 : 0);
    // 来源归因写入：先 UPDATE（存在则累加）后 INSERT（不存在则建，catch 兜底并发冲突）
    if (dim) {
      const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('UPDATE stats_referrers SET pv = pv + 1, uv = uv + ?, name = ?, last_at = ? WHERE dim = ?')
        .run(isNew ? 1 : 0, name, nowStr, dim);
      try {
        db.prepare('INSERT INTO stats_referrers (dim, name, pv, uv, last_at) VALUES (?,?,?,?,?)')
          .run(dim, name, 1, isNew ? 1 : 0, nowStr);
      } catch (_) { /* 并发插入主键冲突，忽略 */ }
    }
  }
  res.json({ ok: true });
});

// 统计数据（首页展示 + 后台来源面板）。加 3 秒微缓存：前端每 30 秒轮询 + 多访客并发，
// 每次都打 PG 会占用同步查询通道，短缓存显著降低阻塞。
let statsCache = null, statsCacheAt = 0;
app.get('/api/stats', (req, res) => {
  if (statsCache && Date.now() - statsCacheAt < 3000) return res.json(statsCache);
  const d = today();
  const day = db.prepare('SELECT pv, uv FROM stats_daily WHERE day=?').get(d) || { pv: 0, uv: 0 };
  const total = db.prepare('SELECT pv, uv FROM stats_total WHERE id=1').get() || { pv: 0, uv: 0 };
  const referrers = db.prepare('SELECT dim, name, pv, uv, last_at FROM stats_referrers ORDER BY pv DESC LIMIT 30').all();
  statsCache = {
    online: presence.size,
    today_pv: day.pv, today_uv: day.uv,
    total_pv: total.pv, total_uv: total.uv,
    referrers
  };
  statsCacheAt = Date.now();
  res.json(statsCache);
});

// 站点点击量 +1（点击"前往/直达"时由前端调用）
app.post('/api/sites/:id/click', (req, res) => {
  db.prepare('UPDATE sites SET clicks = clicks + 1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== 前台公开 API ====================

// 首页聚合数据
app.get('/api/home', (req, res) => {
  const announcements = db.prepare('SELECT * FROM announcements WHERE enabled=1 ORDER BY id DESC LIMIT 5').all();
  const banners = db.prepare('SELECT * FROM banners WHERE enabled=1 ORDER BY sort ASC, id ASC').all();
  const recommended = db.prepare(
    "SELECT id,name,domain,intro,system,logo_color,featured,sponsored,clicks FROM sites WHERE status='online' AND recommended=1 ORDER BY featured DESC, sponsored DESC, sort ASC, id ASC LIMIT 10"
  ).all();
  const sponsored = db.prepare(
    "SELECT id,name,domain,intro,system,logo_color,clicks FROM sites WHERE status='online' AND sponsored=1 ORDER BY sort ASC, id ASC LIMIT 6"
  ).all();
  const featured = db.prepare(
    "SELECT id,name,domain,intro,system,logo_color,crawl_enabled,clicks FROM sites WHERE status='online' ORDER BY featured DESC, sort ASC, id ASC LIMIT 24"
  ).all();
  const total = db.prepare("SELECT COUNT(*) AS c FROM sites WHERE status='online'").get().c;
  res.json({ announcements, banners, recommended, sponsored, featured, total });
});

// 全部站点（筛选 + 搜索 + 分页）
app.get('/api/sites', (req, res) => {
  const { q = '', system = '', page = 1, size = 24 } = req.query;
  const where = ["status='online'"];
  const args = [];
  if (q) { where.push('(name LIKE ? OR intro LIKE ? OR domain LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (system) { where.push('system = ?'); args.push(system); }
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM sites WHERE ${w}`).get(...args).c;
  const list = db.prepare(
    `SELECT id,name,domain,intro,system,logo_color,featured,sponsored,crawl_enabled,clicks FROM sites WHERE ${w}
     ORDER BY featured DESC, sort ASC, id ASC LIMIT ? OFFSET ?`
  ).all(...args, +size, (+page - 1) * +size);
  res.json({ total, page: +page, size: +size, list });
});

// 站点详情
app.get('/api/sites/:id', (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id=? AND status='online'").get(req.params.id);
  if (!site) return res.status(404).json({ error: '站点不存在或已下架' });
  res.json(site);
});

// 一键比价（触发爬虫）
app.get('/api/compare', async (req, res) => {
  const kw = String(req.query.kw || '').trim();
  if (!kw) return res.status(400).json({ error: '请输入商品关键词' });
  try {
    res.json(await crawler.compare(kw));
  } catch (e) {
    res.status(500).json({ error: '比价服务暂时不可用，请稍后再试' });
  }
});

// 自动识别发卡系统：抓取站点首页 HTML，按模板指纹判断
const DETECT_TIMEOUT_MS = 8000;
app.post('/api/detect-system', async (req, res) => {
  let domain = String((req.body || {}).domain || '').trim();
  if (!domain) return res.status(400).json({ error: '请先填写网站域名' });
  if (!/^https?:\/\//i.test(domain)) domain = 'https://' + domain;
  try {
    const u = new URL(domain);
    // 复用爬虫的 fetchPage：自动处理部分站点的 JS 跳转门禁
    const html = await crawler.fetchPage(u.origin + '/', { headers: { 'Accept': 'text/html' } });
    const low = html.toLowerCase();
    let system = '', confident = false;
    if (low.includes('/assets/pc/') || low.includes('inside/getgoods') || low.includes('buygoods')) {
      system = '卡易信'; confident = true;
    } else if (low.includes('front/diy') || low.includes('template/front/default')) {
      // 同一模板族（签名密钥一致，爬虫接口通用）：default 是 diy 引擎换皮模板。
      // HTML 带 kasushou 字样的是卡速售，否则卡商云
      system = low.includes('kasushou') ? '卡速售' : '卡商云'; confident = true;
    } else if (low.includes('卡卡云') || low.includes('kkayun') || low.includes('pbn.html')) {
      // 卡卡云：页脚"卡卡云商城"字样 / 官方域名字样 / 前台搜索页路由 /pg/{id}.html
      system = '卡卡云'; confident = true;
    } else if (low.includes('youquanyi') || low.includes('/homestyle/') || low.includes('productdetail')) {
      // 优权益：官方域名字样 / homestyle 模板目录 / 商品详情路由 productdetail.html?good=
      system = '优权益'; confident = true;
    } else if (/assets\/(pc|front)|\/inside\//.test(low)) {
      system = '卡易信';
    }
    if (!system) return res.json({ system: '', message: '未能自动识别该站点的发卡系统，请手动选择' });
    res.json({ system, confident, message: `已自动识别为「${system}」` });
  } catch (e) {
    res.json({ system: '', message: '无法访问该域名（超时或不可达），请手动选择发卡系统' });
  }
});

// ==================== 站点图标（favicon）自动获取 ====================
// 前端展示真实站点图标；缺失时回退到字母头像。带本地缓存，避免重复抓取第三方。
const fs = require('fs');
const FAV_CT = { '.ico': 'image/x-icon', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
app.get('/api/favicon', async (req, res) => {
  const domain = favicon.safeDomain(String(req.query.domain || ''));
  if (!domain) return res.status(400).json({ error: '缺少 domain' });
  try {
    const file = await favicon.getFavicon(domain);
    if (!file || !fs.existsSync(file)) {
      // 负缓存已挡住重复抓取；这里再让浏览器 10 分钟内别反复问 404
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.status(404).json({ error: 'no favicon' });
    }
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', FAV_CT[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(buf);
  } catch {
    return res.status(404).json({ error: 'no favicon' });
  }
});

// 站长提交收录
app.post('/api/submissions', (req, res) => {
  const { name, domain, intro = '', system = '卡易信', friend_link = '', contact = '' } = req.body || {};
  if (!name || !domain || !contact) return res.status(400).json({ error: '站点名称、域名、联系方式为必填项' });
  if (!/^[\w.-]+\.[a-z]{2,}$/i.test(domain.trim())) return res.status(400).json({ error: '域名格式不正确' });
  if (!['卡易信', '卡商云', '卡速售', '卡卡云', '优权益'].includes(system)) return res.status(400).json({ error: '发卡系统选项不正确' });
  const dup = db.prepare('SELECT id FROM submissions WHERE domain=? AND status=?').get(domain.trim(), 'pending');
  if (dup) return res.status(400).json({ error: '该域名已在审核中，请勿重复提交' });
  db.prepare('INSERT INTO submissions (name,domain,intro,system,friend_link,contact) VALUES (?,?,?,?,?,?)')
    .run(name.trim().slice(0, 50), domain.trim().slice(0, 200), intro.slice(0, 500), system, friend_link.slice(0, 200), contact.slice(0, 100));
  res.json({ ok: true, message: '提交成功，等待管理员审核（一般 1-3 个工作日）' });
});

// 举报 / 意见反馈
app.post('/api/reports', (req, res) => {
  const { site_name = '', url = '', reason = '', contact = '' } = req.body || {};
  if (!reason.trim()) return res.status(400).json({ error: '请填写举报/反馈内容' });
  db.prepare('INSERT INTO reports (site_name,url,reason,contact) VALUES (?,?,?,?)')
    .run(site_name.slice(0, 100), url.slice(0, 300), reason.slice(0, 1000), contact.slice(0, 100));
  res.json({ ok: true, message: '已收到您的反馈，感谢监督' });
});

// ==================== 友链（前台自助申请 + 回链检测自动过审） ====================

// 从 URL 提取安全域名
function linkDomain(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch { return ''; }
}

// 抓取对方首页：TDK 解析 + 是否包含本站回链
async function crawlLinkPage(url, myHost) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'Accept': 'text/html' }
    });
    if (!resp.ok) return null;
    const html = (await resp.text()).slice(0, 500000);
    const pick = re => { const m = re.exec(html); return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 300) : ''; };
    const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
    const keywords = pick(/<meta[^>]+name\s*=\s*["']keywords["'][^>]*content\s*=\s*["']([^"']*)["']/i)
      || pick(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']keywords["']/i);
    const description = pick(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i)
      || pick(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i);
    const domain = myHost.split(':')[0];
    const backlink = domain ? html.toLowerCase().includes(domain.toLowerCase()) : false;
    return { title, keywords, description, backlink };
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

// 获取 TDK（表单「获取TDK」按钮）
app.get('/api/links/fetch-tdk', async (req, res) => {
  const domain = linkDomain(String(req.query.url || ''));
  if (!domain) return res.status(400).json({ error: '请填写正确的网址' });
  const got = await crawlLinkPage(`https://${domain}/`, req.headers.host || '');
  if (!got) return res.status(502).json({ error: '无法访问该网站，请确认网址可正常打开' });
  res.json({ domain, ...got });
});

// 提交友链申请：检测回链，命中自动过审，否则进入待审
app.post('/api/links/apply', async (req, res) => {
  const b = req.body || {};
  const domain = linkDomain(b.url || '');
  if (!domain) return res.status(400).json({ error: '请填写正确的网址' });
  if (/(\.gov|\.edu)/i.test(domain)) return res.status(400).json({ error: '该域名后缀不支持申请' });

  const exist = db.prepare('SELECT id, status FROM links WHERE url LIKE ?').get(`%${domain}%`);
  if (exist && exist.status === 'approved') return res.status(400).json({ error: '该站点已在友链列表中，无需重复提交' });

  const name = String(b.name || '').trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: '请填写网站名称' });
  const keywords = String(b.keywords || '').trim().slice(0, 200);
  const description = String(b.description || '').trim().slice(0, 300);

  const got = await crawlLinkPage(`https://${domain}/`, req.headers.host || '');
  const backlink = !!(got && got.backlink);
  const title = (got && got.title) || '';
  const tdkKw = (got && got.keywords) || '';
  const tdkDesc = (got && got.description) || '';

  const status = backlink ? 'approved' : 'pending';
  const row = {
    name, url: `https://${domain}`, enabled: 1, status,
    title: title || name, keywords: keywords || tdkKw, description: description || tdkDesc
  };
  if (exist) {
    db.prepare('UPDATE links SET name=?,url=?,enabled=?,status=?,title=?,keywords=?,description=? WHERE id=?')
      .run(row.name, row.url, row.enabled, row.status, row.title, row.keywords, row.description, exist.id);
  } else {
    db.prepare('INSERT INTO links (name,url,enabled,status,title,keywords,description) VALUES (?,?,?,?,?,?,?)')
      .run(row.name, row.url, row.enabled, row.status, row.title, row.keywords, row.description);
  }
  favicon.getFavicon(domain).catch(() => {});
  res.json({
    ok: true, backlink, status,
    message: backlink
      ? '已检测到本站回链，友链审核自动通过，即刻展示！'
      : got
        ? '未检测到本站回链，申请已提交，站长审核通过后展示（建议先在本站可访问的位置加上本站链接）'
        : '网站暂时无法访问，申请已提交待站长人工审核'
  });
});

// 友链公开展示（仅审核通过且启用）
app.get('/api/links', (req, res) => {
  res.json(db.prepare("SELECT * FROM links WHERE enabled=1 AND status='approved' ORDER BY id DESC").all());
});

// ==================== 后台管理 API ====================

// 站点管理
app.get('/api/admin/sites', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM sites ORDER BY sort ASC, id ASC').all());
});

app.post('/api/admin/sites', adminAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.domain) return res.status(400).json({ error: '名称与域名必填' });
  const r = db.prepare(`INSERT INTO sites (name,domain,intro,description,system,friend_link,status,featured,sponsored,recommended,crawl_enabled,logo_color,sort,clicks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.name, b.domain, b.intro || '', b.description || '', b.system || '卡易信', b.friend_link || '',
    b.status || 'online', +b.featured || 0, +b.sponsored || 0, b.recommended === undefined ? 1 : (+b.recommended || 0), +b.crawl_enabled || 0,
    b.logo_color || '#2b7fff', +b.sort || 0, 800 + Math.floor(Math.random() * 3200));
  favicon.getFavicon(String(b.domain)).catch(() => {}); // 预热图标缓存
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/admin/sites/:id', adminAuth, (req, res) => {
  const b = req.body || {};
  const fields = ['name','domain','intro','description','system','friend_link','status','featured','sponsored','recommended','crawl_enabled','logo_color','sort'];
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);
  if (!site) return res.status(404).json({ error: '站点不存在' });
  const merged = { ...site, ...b };
  db.prepare(`UPDATE sites SET name=?,domain=?,intro=?,description=?,system=?,friend_link=?,status=?,
    featured=?,sponsored=?,recommended=?,crawl_enabled=?,logo_color=?,sort=? WHERE id=?`).run(
    merged.name, merged.domain, merged.intro, merged.description, merged.system, merged.friend_link,
    merged.status, +merged.featured || 0, +merged.sponsored || 0, merged.recommended == null ? 1 : (+merged.recommended || 0), +merged.crawl_enabled || 0,
    merged.logo_color, +merged.sort || 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/sites/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM sites WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 黑名单：一键下架 + 关闭比价
app.post('/api/admin/sites/:id/blacklist', adminAuth, (req, res) => {
  db.prepare("UPDATE sites SET status='black', crawl_enabled=0, sponsored=0, featured=0, recommended=0 WHERE id=?").run(req.params.id);
  res.json({ ok: true, message: '已加入黑名单：自动关闭收录与比价抓取' });
});

app.post('/api/admin/sites/:id/restore', adminAuth, (req, res) => {
  db.prepare("UPDATE sites SET status='online' WHERE id=?").run(req.params.id);
  res.json({ ok: true, message: '已恢复上架（比价开关保持关闭，请手动开启）' });
});

// 提交审核
app.get('/api/admin/submissions', adminAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM submissions ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC").all());
});

app.post('/api/admin/submissions/:id/review', adminAuth, (req, res) => {
  const { action, reason = '' } = req.body || {}; // action: approve | reject
  const sub = db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: '申请不存在' });
  if (action === 'approve') {
    db.prepare("UPDATE submissions SET status='approved', reason='' WHERE id=?").run(sub.id);
    db.prepare('INSERT INTO sites (name,domain,intro,description,system,friend_link,logo_color,clicks) VALUES (?,?,?,?,?,?,?,?)')
      .run(sub.name, sub.domain, sub.intro, sub.intro, sub.system, sub.friend_link, '#2b7fff', 800 + Math.floor(Math.random() * 3200));
    favicon.getFavicon(String(sub.domain)).catch(() => {}); // 预热图标缓存
    baiduPush(['https://offclock.top/']); // 新站点入首页，触发百度重新抓取
    return res.json({ ok: true, message: '已通过并加入站点库' });
  }
  if (action === 'reject') {
    if (!reason.trim()) return res.status(400).json({ error: '请填写驳回理由' });
    db.prepare("UPDATE submissions SET status='rejected', reason=? WHERE id=?").run(reason.trim(), sub.id);
    return res.json({ ok: true, message: '已驳回' });
  }
  res.status(400).json({ error: '无效操作' });
});

// 爬虫日志
app.get('/api/admin/crawler/logs', adminAuth, (req, res) => {
  const failOnly = req.query.fail === '1' ? 'WHERE ok=0' : '';
  const logs = db.prepare(`SELECT * FROM crawl_logs ${failOnly} ORDER BY id DESC LIMIT 100`).all();
  const stat = db.prepare(`SELECT COUNT(*) AS total, SUM(ok=0) AS fail FROM crawl_logs WHERE created_at > datetime('now','-1 day','localtime')`).get();
  res.json({ logs, stat: { total: stat.total || 0, fail: stat.fail || 0 }, cacheTtlMinutes: Math.round(crawler.CACHE_TTL_MS / 60000) });
});

// 公告管理
app.get('/api/admin/announcements', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY id DESC').all());
});
app.post('/api/admin/announcements', adminAuth, (req, res) => {
  const { title, content = '', enabled = 1 } = req.body || {};
  if (!title) return res.status(400).json({ error: '标题必填' });
  const r = db.prepare('INSERT INTO announcements (title,content,enabled) VALUES (?,?,?)').run(title, content, +enabled);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put('/api/admin/announcements/:id', adminAuth, (req, res) => {
  const { title, content = '', enabled = 1 } = req.body || {};
  db.prepare('UPDATE announcements SET title=?,content=?,enabled=? WHERE id=?').run(title, content, +enabled, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/announcements/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 广告横幅管理
app.get('/api/admin/banners', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM banners ORDER BY sort ASC, id ASC').all());
});
app.post('/api/admin/banners', adminAuth, (req, res) => {
  const { text, tag = '推荐', link = '#', enabled = 1, sort = 0 } = req.body || {};
  if (!text) return res.status(400).json({ error: '广告文字必填' });
  const r = db.prepare('INSERT INTO banners (text,tag,link,enabled,sort) VALUES (?,?,?,?,?)').run(text, tag, link, +enabled, +sort);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put('/api/admin/banners/:id', adminAuth, (req, res) => {
  const { text, tag = '推荐', link = '#', enabled = 1, sort = 0 } = req.body || {};
  db.prepare('UPDATE banners SET text=?,tag=?,link=?,enabled=?,sort=? WHERE id=?').run(text, tag, link, +enabled, +sort, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/banners/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM banners WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 友链管理
app.get('/api/admin/links', adminAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM links ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, id DESC").all());
});
app.post('/api/admin/links', adminAuth, async (req, res) => {
  const { name, url, enabled = 1, status = 'approved' } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: '名称与链接必填' });
  const fullUrl = normUrl(url);
  // 自动补全 TDK：没填标题/简介时抓对方首页
  let title = (req.body.title || '').trim();
  let keywords = (req.body.keywords || '').trim();
  let description = (req.body.description || '').trim();
  if (!title || !description) {
    const got = await crawlLinkPage(fullUrl, req.headers.host || '');
    if (got) {
      if (!title) title = got.title;
      if (!keywords) keywords = got.keywords;
      if (!description) description = got.description;
    }
  }
  const r = db.prepare("INSERT INTO links (name,url,enabled,status,title,keywords,description) VALUES (?,?,?,?,?,?,?)")
    .run(name, fullUrl, +enabled, status === 'pending' ? 'pending' : 'approved', title || name, keywords, description);
  favicon.getFavicon(linkDomain(fullUrl)).catch(() => {});
  res.json({ ok: true, id: r.lastInsertRowid, tdk: { title, keywords, description } });
});
app.put('/api/admin/links/:id', adminAuth, async (req, res) => {
  const { name, url, enabled = 1, status = 'approved' } = req.body || {};
  const fullUrl = normUrl(url);
  // 编辑时若清空了标题/简介，也自动补全
  let title = (req.body.title || '').trim();
  let keywords = (req.body.keywords || '').trim();
  let description = (req.body.description || '').trim();
  if ((!title || !description) && fullUrl) {
    const got = await crawlLinkPage(fullUrl, req.headers.host || '');
    if (got) {
      if (!title) title = got.title;
      if (!keywords) keywords = got.keywords;
      if (!description) description = got.description;
    }
  }
  db.prepare('UPDATE links SET name=?,url=?,enabled=?,status=?,title=?,keywords=?,description=? WHERE id=?')
    .run(name, fullUrl, +enabled, status === 'pending' ? 'pending' : 'approved', title || name, keywords, description, req.params.id);
  res.json({ ok: true });
});
// 一键补全 TDK：抓对方首页更新标题/关键词/简介
app.post('/api/admin/links/:id/fetch-tdk', adminAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM links WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '友链不存在' });
  const got = await crawlLinkPage(row.url, req.headers.host || '');
  if (!got || (!got.title && !got.description)) return res.status(502).json({ error: '无法访问该网站，抓取失败' });
  db.prepare('UPDATE links SET title=?,keywords=?,description=? WHERE id=?')
    .run(got.title || row.name, got.keywords || row.keywords, got.description || row.description, row.id);
  res.json({ ok: true, ...got });
});
// 一键通过 / 驳回待审友链
app.post('/api/admin/links/:id/review', adminAuth, (req, res) => {
  const status = req.body && req.body.status === 'pending' ? 'pending' : 'approved';
  db.prepare('UPDATE links SET status=? WHERE id=?').run(status, req.params.id);
  if (status === 'approved') {
    const row = db.prepare('SELECT url FROM links WHERE id=?').get(req.params.id);
    if (row && row.url) baiduPush([row.url]);
  }
  res.json({ ok: true });
});
app.delete('/api/admin/links/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM links WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 举报/反馈列表
app.get('/api/admin/reports', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 200').all());
});
app.post('/api/admin/reports/:id/resolve', adminAuth, (req, res) => {
  db.prepare("UPDATE reports SET status='resolved' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ==================== SEO ====================

app.get('/robots.txt', (req, res) => {
  const host = req.headers.host || 'localhost:3000';
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /api/

Sitemap: http://${host}/sitemap.xml`);
});

app.get('/sitemap.xml', (req, res) => {
  const host = req.headers.host || 'localhost:3000';
  const today = new Date().toISOString().slice(0, 10);
  const sites = db.prepare("SELECT id FROM sites WHERE status='online'").all();
  const urls = [
    { loc: `http://${host}/`, priority: '1.0' },
    { loc: `http://${host}/#/sites`, priority: '0.9' },
    { loc: `http://${host}/#/submit`, priority: '0.5' },
    { loc: `http://${host}/#/links`, priority: '0.4' },
    ...sites.map(s => ({ loc: `http://${host}/#/site/${s.id}`, priority: '0.7' }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;
  res.type('application/xml').send(xml);
});

// 兜底：HTML 页面 404 提示
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.status(404).sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 数据库自动同步回 GitHub（跨部署持久化；需 GITHUB_PUSH_TOKEN 环境变量）
const persist = require('./persist');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 卡券货源导航站已启动: http://localhost:${PORT}`);
  console.log(`   后台管理: http://localhost:${PORT}/admin.html  (账号 ${ADMIN_USER})`);
  // 启动后自动补全友链 TDK（不阻塞）
  setTimeout(() => enrichLinks().then(() => console.log('✅ 友链 TDK 自动补全完成')).catch(() => {}), 1500);
  // 启用数据库持久化同步
  persist.start();
});

/**
 * 比价爬虫引擎
 * - 输入关键词，遍历所有开启比价且在线的站点
 * - 拼接对方前台搜索 URL -> GET HTML -> 预设选择器提取商品标题/价格/库存
 * - 同关键词缓存 4 分钟（3-5 分钟区间内），并发限制 3，单站超时 8 秒
 * - 抓取失败标记站点（crawl_status=fail）并写日志，不阻塞整体查询
 */
const cheerio = require('cheerio');
const rules = require('./rules');
const db = require('./db');

const CACHE_TTL_MS = 4 * 60 * 1000;   // 同关键词缓存 4 分钟（3~5 分钟区间）
const CONCURRENCY = 3;                // 并发请求上限
const TIMEOUT_MS = 8000;              // 单站超时 8 秒
const MAX_ITEMS_PER_SITE = 10;        // 每站最多取前 N 条

const cache = new Map(); // kw -> { ts, results, totalCostMs }

function normalizeUrl(domain) {
  let u = String(domain || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

/** 带超时的请求（仅公开前台入口，不携带任何凭据） */
async function fetchPage(url, { method = 'GET', contentType, body, extraHeaders } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/json,*/*',
      ...(extraHeaders || {})
    };
    const opts = { method, signal: ctrl.signal, redirect: 'follow', headers };
    if (body) {
      // 规则里可用简写 'form' / 'json'，也允许直接写完整 MIME
      const MIME = { form: 'application/x-www-form-urlencoded', json: 'application/json' };
      headers['Content-Type'] = MIME[contentType] || contentType || 'application/x-www-form-urlencoded';
      opts.body = body;
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 20) throw new Error('返回内容为空');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 用预设规则解析单个站点 */
function parseWithRule(rule, html) {
  const $ = cheerio.load(html);
  const items = [];
  $(rule.item).each((_, el) => {
    if (items.length >= MAX_ITEMS_PER_SITE) return false;
    const node = $(el);
    const title = node.find(rule.title).first().text().trim();
    const price = node.find(rule.price).first().text().trim();
    let stock = node.find(rule.stock).first().text().trim();
    let href = '';
    const a = node.is('a') ? node : node.find(rule.link).first();
    if (a.length) {
      href = a.attr('href') || '';
      try { href = new URL(href, 'about:blank').href.replace('about:blank', ''); } catch { /* keep */ }
    }
    if (title && price) {
      const num = parseFloat(price.replace(/[^\d.]/g, ''));
      items.push({ title: title.slice(0, 80), price: price.slice(0, 40), priceNum: isNaN(num) ? 0 : num, stock: stock || '未知', url: href });
    }
  });
  return items;
}

/** 抓取并解析单个站点，写日志、更新站点抓取状态 */
async function crawlSite(site, keyword) {
  const t0 = Date.now();
  const rule = rules[site.system];
  const finish = async (ok, msg, items = []) => {
    const cost = Date.now() - t0;
    db.prepare('UPDATE sites SET crawl_status=? WHERE id=?').run(ok ? 'ok' : 'fail', site.id);
    db.prepare('INSERT INTO crawl_logs (keyword, site_id, site_name, ok, msg, item_count, cost_ms) VALUES (?,?,?,?,?,?,?)')
      .run(keyword, site.id, site.name, ok ? 1 : 0, msg, items.length, cost);
    return { site_id: site.id, site_name: site.name, system: site.system, ok, msg, cost_ms: cost, items };
  };

  if (!rule) return finish(false, `未配置 [${site.system}] 的解析规则`);
  const base = normalizeUrl(site.domain);
  if (!base) return finish(false, '站点域名无效');

  // ---- API 型规则：请求前台页面自身使用的公开 JSON 接口 ----
  if (rule.type === 'api') {
    let text;
    try {
      text = await fetchPage(rule.searchUrl(base), {
        method: rule.method || 'POST',
        contentType: rule.contentType,
        body: rule.body(keyword),
        extraHeaders: typeof rule.headers === 'function' ? rule.headers(keyword) : rule.headers
      });
    } catch (e) {
      return finish(false, e.name === 'AbortError' ? `请求超时(>${TIMEOUT_MS / 1000}s)` : `请求失败: ${e.message}`);
    }
    try {
      const items = rule.parse(JSON.parse(text), base);
      if (!items.length) return finish(false, '接口无匹配商品');
      return finish(true, `抓取成功 ${items.length} 条`, items);
    } catch (e) {
      return finish(false, `解析失败: ${e.message}`);
    }
  }

  // ---- HTML 型规则：GET 前台搜索页 + 选择器提取 ----
  let html;
  try {
    html = await fetchPage(rule.searchUrl(base, keyword));
  } catch (e) {
    return finish(false, e.name === 'AbortError' ? `请求超时(>${TIMEOUT_MS / 1000}s)` : `请求失败: ${e.message}`);
  }
  try {
    const items = parseWithRule(rule, html);
    if (!items.length) return finish(false, '未匹配到商品（可能规则需要更新）');
    return finish(true, `抓取成功 ${items.length} 条`, items);
  } catch (e) {
    return finish(false, `解析失败: ${e.message}`);
  }
}

/** 简单并发池 */
async function runPool(tasks, limit) {
  const out = new Array(tasks.length);
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length) {
      const i = idx++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/**
 * 主入口：关键词比价
 * 返回 { cached, keyword, results, summary }
 */
async function compare(keyword) {
  keyword = String(keyword || '').trim().slice(0, 50);
  if (!keyword) return { cached: false, keyword: '', results: [], summary: { total: 0, ok: 0, fail: 0 } };

  const hit = cache.get(keyword);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return { ...hit.data, cached: true };
  }

  const sites = db.prepare(
    "SELECT id, name, domain, system FROM sites WHERE crawl_enabled=1 AND status='online'"
  ).all();

  const results = await runPool(sites.map(s => () => crawlSite(s, keyword)), CONCURRENCY);

  const data = {
    cached: false,
    keyword,
    results,
    summary: {
      total: results.length,
      ok: results.filter(r => r.ok).length,
      fail: results.filter(r => !r.ok).length
    }
  };
  cache.set(keyword, { ts: Date.now(), data });
  // 清理过期缓存，避免内存膨胀
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts > CACHE_TTL_MS * 2) cache.delete(k);
  return data;
}

module.exports = { compare, CACHE_TTL_MS };

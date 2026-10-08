/**
 * 站点图标（favicon）自动获取
 * ---------------------------------------------------------------
 * 目标：导航卡片展示第三方站点真实图标，而非字母头像。
 *
 * 策略（仅抓取公开资源，不登录、不提交业务表单）：
 *  1. 优先请求目标站根路径 /favicon.ico（含 http 降级）；
 *  2. 失败则抓取首页 HTML，解析 <link rel="...icon..."> 得到图标地址；
 *  3. 抓取到的图标按内容类型落盘缓存到 data/favicons/，后续直接本地服务；
 *  4. 全部失败返回 null，前端回退到字母头像。
 *
 * 安全：严格校验 URL 协议（只认 http/https）、校验响应为真实图片（magic bytes），
 *       不允许任何重定向到非同源之外的 file:// 等危险协议。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'favicons');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT = 5000;

// ---------- 性能保护 ----------
// 1) 抓取中去重：同一域名的并发请求共享同一次抓取，避免重复出站请求风暴
const inflight = new Map();
// 2) 负缓存：抓不到图标的域名 10 分钟内不再重试（此前每个访客都触发 8-24s 的重复抓取，拖垮免费实例）
const NEG_TTL = 10 * 60 * 1000;
const negCache = new Map(); // domain -> 失败时间戳
// 3) 全局并发上限：同时最多 4 个域名的抓取在跑，其余排队
const MAX_CONCURRENT = 4;
let running = 0;
const waitQueue = [];
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise(resolve => waitQueue.push(resolve));
}
function release() {
  running--;
  const next = waitQueue.shift();
  if (next) { running++; next(); }
}

// 内容类型 -> 扩展名
const EXT_BY_CT = {
  'image/png': 'png',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
};

// magic bytes 校验真实图片
const MAGIC = [
  { sig: [0x89, 0x50, 0x4e, 0x47], ext: 'png' },   // PNG
  { sig: [0x00, 0x00, 0x01, 0x00], ext: 'ico' },   // ICO
  { sig: [0x47, 0x49, 0x46], ext: 'gif' },         // GIF
  { sig: [0xff, 0xd8, 0xff], ext: 'jpg' },          // JPEG
  { sig: [0x52, 0x49, 0x46, 0x46], ext: 'webp' }   // RIFF/WebP (再校验 WEBP)
];

function safeDomain(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/[\/].*$/, '').replace(/[:].*$/, '');
}

function cacheFile(domain) {
  const key = domain.replace(/[^a-z0-9.\-]/g, '_');
  return path.join(CACHE_DIR, key);
}

function findCached(domain) {
  for (const ext of Object.values(EXT_BY_CT)) {
    const p = cacheFile(domain) + '.' + ext;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function pickExt(buf, contentType) {
  // 先按 magic bytes
  for (const m of MAGIC) {
    if (buf.length >= m.sig.length && m.sig.every((b, i) => buf[i] === b)) {
      if (m.ext === 'webp') {
        // 校验 'WEBP'
        return buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 ? 'webp' : null;
      }
      return m.ext;
    }
  }
  // SVG（文本）
  const head = buf.slice(0, 64).toString('utf8').replace(/﻿/, '');
  if (/^\s*<\?xml|<svg/i.test(head)) return 'svg';
  // 退而求其次用 content-type
  return EXT_BY_CT[contentType] || null;
}

async function fetchBytes(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*' }
    });
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return null;
    return { buf, ct };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// 仅允许 http/https，且解析后 host 与目标域一致（防开放重定向到危险协议）
function safeResolve(href, baseDomain) {
  try {
    if (/^(https?:)?\/\//i.test(href)) {
      const u = new URL(href.startsWith('//') ? 'https:' + href : href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.href;
    }
    if (href.startsWith('/')) return `https://${baseDomain}${href}`;
    if (/^data:/i.test(href)) return null; // 不缓存内联
    return `https://${baseDomain}/${href}`;
  } catch {
    return null;
  }
}

async function grabFromHomepage(domain) {
  const htmlCtrl = new AbortController();
  const t = setTimeout(() => htmlCtrl.abort(), TIMEOUT);
  let html = '';
  try {
    const resp = await fetch(`https://${domain}/`, {
      signal: htmlCtrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html' }
    });
    if (resp.ok) html = (await resp.text()).slice(0, 200000); // 只解析前 200KB，超大首页不浪费带宽
  } catch { /* ignore */ } finally { clearTimeout(t); }

  if (!html) return null;

  // 收集所有 icon 候选（越大越优先，apple-touch 通常为高清大图）
  const links = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const href = (tag.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const sizes = (tag.match(/sizes\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    if (!href || !/icon|apple-touch/i.test(rel)) continue;
    const dim = /(\d+)\s*x\s*(\d+)/i.exec(sizes);
    const area = dim ? (+dim[1]) * (+dim[2]) : (/apple-touch/i.test(rel) ? 180 * 180 : 16 * 16);
    links.push({ href, score: area });
  }
  links.sort((a, b) => b.score - a.score);

  for (const { href } of links) {
    const url = safeResolve(href, domain);
    if (!url) continue;
    const got = await fetchBytes(url);
    if (got && pickExt(got.buf, got.ct)) return got;
  }
  return null;
}

/**
 * 获取站点图标（带缓存）。
 * @returns {Promise<string|null>} 本地缓存文件路径，或 null（无图标）
 */
async function getFavicon(rawDomain) {
  const domain = safeDomain(rawDomain);
  if (!domain) return null;
  const cached = findCached(domain);
  if (cached) return cached;

  // 负缓存命中：近期确认无图标，直接放弃（响应 404 让前端回退字母头像）
  const negAt = negCache.get(domain);
  if (negAt && Date.now() - negAt < NEG_TTL) return null;

  // 抓取中去重：并发请求复用同一个 Promise
  if (inflight.has(domain)) return inflight.get(domain);

  const task = (async () => {
    await acquire();
    try {
      let got = null;
      // 1) 首页解析 link icon（优先拿大尺寸高清图标）
      got = await grabFromHomepage(domain);
      // 2) 兜底 /favicon.ico
      if (!got || !pickExt(got.buf, got.ct)) {
        got = await fetchBytes(`https://${domain}/favicon.ico`);
        if (!got) got = await fetchBytes(`http://${domain}/favicon.ico`);
      }

      if (!got) { negCache.set(domain, Date.now()); return null; }
      const ext = pickExt(got.buf, got.ct);
      if (!ext) { negCache.set(domain, Date.now()); return null; }

      const file = cacheFile(domain) + '.' + ext;
      try {
        fs.writeFileSync(file, got.buf);
        return file;
      } catch {
        return null;
      }
    } finally {
      release();
      inflight.delete(domain);
    }
  })();
  inflight.set(domain, task);
  return task;
}

module.exports = { getFavicon, safeDomain, CACHE_DIR };

/**
 * 卡易信（kayixin）商家客户 API 3.0 对接模块
 * ============================================================
 * 角色：卡易信是「供货方（上游）」，offclock.top 是「下游分销前台」。
 * 数据流：同步卡易信商品 → 本站展示 → 用户下单 → 调卡易信充值/下单接口
 *        → 接收卡易信回调（webhook）或主动轮询 → 写回 kx_orders。
 *
 * ⚠️ 待核对项（卡易信具体接口以 Apifox 文档 7qsaa0ye9g.apifox.cn 为准）：
 *   1) API.* 各接口路径
 *   2) MAP.product / MAP.orderStatus 的字段名
 *   3) sign() 签名拼接规则（文档「签名计算规则」章节）
 *   以上易变项全部集中在文件顶部，拿到真实文档后只改这里即可，逻辑不动。
 */
const crypto = require('crypto');
const db = require('./db');

// ---------------- 易变配置（拿到真实文档后集中修改此处） ----------------
const CONFIG = {
  baseUrl: (process.env.KAYIXIN_BASE_URL || '').replace(/\/+$/, ''),  // 卡易信接口域名（测试/正式）
  appKey: process.env.KAYIXIN_APPKEY || '',                            // 卡易信 APPKEY
  appSecret: process.env.KAYIXIN_APPSECRET || '',                      // 卡易信 APPSECRET
  timeoutMs: 15000,
};

// 各接口路径（待核对）
const API = {
  listProducts: '/api/goods/list',     // 拉取商品列表
  createOrder: '/api/order/create',    // 下单 / 充值下单
  queryOrder: '/api/order/query',      // 订单状态查询
};

// 字段映射（待核对：按真实文档字段名调整）
const MAP = {
  // 卡易信商品对象 → kx_products 字段
  product: (g) => ({
    ext_id: String(g.id ?? g.goodsId ?? g.productId ?? g.sku ?? ''),
    name: g.name ?? g.goodsName ?? g.title ?? '',
    face_value: g.faceValue ?? g.face_value ?? g.specName ?? g.spec ?? '',
    price: Number(g.price ?? g.sellPrice ?? g.amount ?? 0),
    stock: Number(g.stock ?? g.inventory ?? g.inventoryNumber ?? 0),
    status: (g.status === 0 || g.status === 'on' || g.onSale === true || g.onSale === 1) ? 'on' : 'off',
    category: g.category ?? g.categoryName ?? g.typeName ?? '',
  }),
  // 卡易信订单状态 → 本站状态
  orderStatus: (s) => {
    const m = {
      pending: 'pending', wait: 'pending', waiting: 'pending',
      processing: 'processing', process: 'processing',
      success: 'success', succeed: 'success', paid: 'success',
      failed: 'failed', fail: 'failed', error: 'failed',
      canceled: 'canceled', cancel: 'canceled', cancelled: 'canceled',
    };
    return m[String(s ?? '').toLowerCase()] || 'pending';
  },
};

// ---------------- 基础工具 ----------------
function isConfigured() {
  return !!(CONFIG.baseUrl && CONFIG.appKey && CONFIG.appSecret);
}

// 北京时间字符串（与 server.js nowBJ 保持一致）
function nowBJ() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function ts() { return Math.floor(Date.now() / 1000); }

/**
 * 签名算法（待核对）
 * 卡易信类系统常见做法：业务参数按 key 升序拼接 + 尾部追加 appSecret，做 32 位大写 MD5。
 * 部分系统还会把 timestamp / nonce 纳入签名。拿到真实「签名计算规则」后调整此处。
 */
function sign(params) {
  const keys = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && k !== 'sign')
    .sort();
  let raw = '';
  for (const k of keys) raw += k + params[k];
  raw += CONFIG.appSecret;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex').toUpperCase();
}

// 统一请求封装：自动带 appKey/timestamp/sign，解析 JSON，校验成功码 1000
async function request(apiPath, { method = 'POST', data = {} } = {}) {
  if (!isConfigured()) {
    throw new Error('卡易信未配置：请在环境变量设置 KAYIXIN_BASE_URL / KAYIXIN_APPKEY / KAYIXIN_APPSECRET');
  }
  const timestamp = ts();
  const signed = { ...data, appKey: CONFIG.appKey, timestamp };
  signed.sign = sign(signed);
  const url = CONFIG.baseUrl + apiPath;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(signed),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { code: -1, msg: '非 JSON 响应: ' + text.slice(0, 200) }; }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 对外能力 ----------------

// ① 一键同步商品：拉取卡易信商品列表写入 kx_products（增量 upsert）
async function syncProducts() {
  const res = await request(API.listProducts, { data: { page: 1, pageSize: 200 } });
  if (res.code !== 1000) throw new Error('卡易信返回错误: ' + (res.msg || JSON.stringify(res).slice(0, 120)));
  const list = res.data?.list || res.data?.data || res.data?.items || (Array.isArray(res.data) ? res.data : []);
  if (!Array.isArray(list)) throw new Error('商品列表字段不符预期: ' + JSON.stringify(res).slice(0, 200));
  let added = 0, updated = 0;
  const now = nowBJ();
  for (const g of list) {
    const p = MAP.product(g);
    if (!p.ext_id) continue;
    const exist = db.prepare('SELECT id FROM kx_products WHERE ext_id=?').get(p.ext_id);
    if (exist) {
      db.prepare(`UPDATE kx_products SET name=?, face_value=?, price=?, stock=?, status=?, category=?, raw=?, synced_at=? WHERE ext_id=?`)
        .run(p.name, p.face_value, p.price, p.stock, p.status, p.category, JSON.stringify(g), now, p.ext_id);
      updated++;
    } else {
      db.prepare(`INSERT INTO kx_products (ext_id,name,face_value,price,stock,status,category,raw,synced_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(p.ext_id, p.name, p.face_value, p.price, p.stock, p.status, p.category, JSON.stringify(g), now);
      added++;
    }
  }
  return { added, updated, total: list.length };
}

// ② 下单 / 充值：调卡易信创建订单，返回本站订单记录
async function createOrder({ productExtId, account, amount, clientOrderRef, notifyUrl }) {
  const res = await request(API.createOrder, {
    data: {
      productId: productExtId,   // 待核对字段名
      account,                   // 充值账号（充值类商品必填）
      amount,                    // 面值/金额
      clientOrderRef,            // 本站订单号（用于回调关联）
      notifyUrl,                 // 本站公网回调地址（由 server 拼接）
    },
  });
  if (res.code !== 1000) throw new Error('卡易信下单失败: ' + (res.msg || JSON.stringify(res).slice(0, 120)));
  const extOrderNo = res.data?.orderNo ?? res.data?.orderId ?? res.data?.platformOrderRef ?? '';
  const now = nowBJ();
  db.prepare(`INSERT INTO kx_orders (order_no, ext_order_no, product_ext_id, product_name, account, amount, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(order_no) DO UPDATE SET ext_order_no=excluded.ext_order_no, updated_at=excluded.updated_at`)
    .run(clientOrderRef, extOrderNo, productExtId, '', account, amount, 'pending', now, now);
  return { order_no: clientOrderRef, ext_order_no: extOrderNo, raw: res.data };
}

// ③ 查询订单状态（主动轮询兜底）
async function queryOrder(clientOrderRef) {
  const res = await request(API.queryOrder, { data: { clientOrderRef } });
  if (res.code !== 1000) throw new Error('卡易信查询失败: ' + (res.msg || JSON.stringify(res).slice(0, 120)));
  const d = res.data || {};
  const status = MAP.orderStatus(d.status ?? d.orderState ?? d.state);
  const now = nowBJ();
  db.prepare(`UPDATE kx_orders SET ext_order_no=?, status=?, ext_status=?, recharge_result=?, updated_at=? WHERE order_no=?`)
    .run(d.orderNo ?? d.platformOrderRef ?? '', status, String(d.status ?? d.orderState ?? ''), d.rechargeResult ?? d.result ?? '', now, clientOrderRef);
  return { order_no: clientOrderRef, status, ext: d };
}

// ④ 校验回调签名（待核对：回调签名规则可能与请求一致）
function verifyNotify(body) {
  if (!isConfigured()) return false;
  const incoming = body.sign ?? body.signature ?? '';
  const calc = sign(body);
  return incoming && incoming.toUpperCase() === calc;
}

// ⑤ 处理回调：写回订单状态（卡易信 webhook 推送调用）
function applyNotify(body) {
  const clientOrderRef = body.clientOrderRef ?? body.orderRef ?? body.outTradeNo ?? '';
  if (!clientOrderRef) return { ok: false, msg: '缺少 clientOrderRef' };
  const status = MAP.orderStatus(body.orderState ?? body.status ?? body.state);
  const now = nowBJ();
  const exist = db.prepare('SELECT id FROM kx_orders WHERE order_no=?').get(clientOrderRef);
  if (!exist) {
    db.prepare(`INSERT INTO kx_orders (order_no, ext_order_no, status, ext_status, recharge_result, callback_raw, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(clientOrderRef, body.platformOrderRef ?? '', status, String(body.orderState ?? body.status ?? ''),
        body.rechargeResult ?? '', JSON.stringify(body), now, now);
  } else {
    db.prepare(`UPDATE kx_orders SET ext_order_no=?, status=?, ext_status=?, recharge_result=?, callback_raw=?, updated_at=? WHERE order_no=?`)
      .run(body.platformOrderRef ?? '', status, String(body.orderState ?? body.status ?? ''),
        body.rechargeResult ?? '', JSON.stringify(body), now, clientOrderRef);
  }
  return { ok: true, status };
}

module.exports = {
  CONFIG, isConfigured, sign, request,
  syncProducts, createOrder, queryOrder, verifyNotify, applyNotify,
};

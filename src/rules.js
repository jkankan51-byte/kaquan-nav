/**
 * 比价爬虫解析规则
 * ---------------------------------------------------------------
 * 原则（硬性约束）：
 *  1. 仅请求第三方站点【公开前台】搜索入口，不登录、不提交业务表单、不携带 Cookie；
 *  2. 每条规则二选一：
 *     - type:'html' ：GET 前台搜索页 HTML，用 CSS 选择器提取（目标站改版只改选择器）；
 *     - type:'api'  ：请求前台页面自身调用的公开 JSON 接口（与浏览器访问等价），
 *                     用 parse(json, base) 提取字段。
 *  3. 任何规则失败都不阻塞整体查询，由 crawler 统一标记并写日志。
 */
const crypto = require('crypto');

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

/**
 * front/diy 模板族（卡商云 / 卡速售）前台签名。
 * 从模板前端 JS 逆向验证：
 *   Sign = md5( md5( md5(key) + t ) ) + t ，t 为秒级时间戳
 * 该签名前台浏览器每次请求都会生成，本实现与前台用户操作完全等价。
 */
const DIY_SIGN_KEY = 'front18a3257675b85febdfcdd83e7150c0b9';
function diySign() {
  const t = Math.round(Date.now() / 1000).toString();
  return md5(md5(md5(DIY_SIGN_KEY) + t)) + t;
}

/** front/diy 模板族通用的解析与链接生成 */
function diyParse(json, base) {
  const list = Array.isArray(json.data) ? json.data : [];
  return list.map(g => {
    const price = [g.goods_price, g.face_value, g.min_level_price].find(v => +v > 0) || 0;
    return {
      title: String(g.goods_name || '').slice(0, 80),
      price: price ? `¥${(+price).toFixed(2)}` : '面议',
      priceNum: +price || 0,
      stock: +g.stock_num > 0 ? `${g.stock_num} 件` : '库存充足',
      // 商品详情页路由（从模板前端源码验证）：history 模式 /goods?id={id}
      url: g.id ? `${base}/goods?id=${g.id}` : base
    };
  }).filter(it => it.title);
}

module.exports = {
  // ============ 卡易信（已实测验证的公开前台接口） ============
  // 浏览器在前台搜索时就是 POST /inside/getGoods（application/x-www-form-urlencoded，keyWord=关键词），
  // 本规则与前台用户操作完全等价，无任何登录/签名要求。
  卡易信: {
    label: '卡易信前台模板',
    type: 'api',
    method: 'POST',
    contentType: 'form',
    searchUrl: base => `${base}/inside/getGoods`,
    body: kw => `keyWord=${encodeURIComponent(kw)}&page=1&limit=10`,
    parse(json, base) {
      const list = Array.isArray(json.goodsList) ? json.goodsList : [];
      return list.map(g => {
        const price = [g.SalePrice, g.MinPrice, g.StockPrice].find(v => +v > 0) || 0;
        return {
          title: String(g.Name || '').slice(0, 80),
          price: price ? `¥${(+price).toFixed(2)}` : '面议',
          priceNum: +price || 0,
          stock: +g.StockCount > 0 ? `${g.StockCount} 件` : '库存充足',
          // 卡易信真实商品页路由（从前端源码验证）：/inside/buyGoods?goodId={Gid}
          url: g.Gid ? `${base}/inside/buyGoods?goodId=${g.Gid}` : base
        };
      }).filter(it => it.title);
    }
  },

  // ============ 卡商云（front/diy 模板 + 前台签名接口，已实测验证） ============
  卡商云: {
    label: '卡商云前台模板',
    type: 'api',
    method: 'POST',
    contentType: 'form',
    headers: () => ({ Sign: diySign() }),
    searchUrl: base => `${base}/front/diy/goods/index`,
    body: kw => `page=1&limit=10&keyword=${encodeURIComponent(kw)}`,
    parse: diyParse
  },

  // ============ 卡速售（同一 front/diy 模板族，接口与签名通用，已实测验证） ============
  卡速售: {
    label: '卡速售前台模板',
    type: 'api',
    method: 'POST',
    contentType: 'form',
    headers: () => ({ Sign: diySign() }),
    searchUrl: base => `${base}/front/diy/goods/index`,
    body: kw => `page=1&limit=10&keyword=${encodeURIComponent(kw)}`,
    parse: diyParse
  },

  // ============ 优权益（ThinkPHP JSON 接口，已在官方零售演示站实测验证） ============
  // 前台商品列表页（/home/productlist?search=x）通过 ajax 调 POST /Product/getproductlist，
  // 必须 application/json + X-Requested-With: XMLHttpRequest（ThinkPHP ajax 检测），无签名。
  优权益: {
    label: '优权益前台模板',
    type: 'api',
    method: 'POST',
    contentType: 'json',
    headers: () => ({ 'X-Requested-With': 'XMLHttpRequest' }),
    searchUrl: base => `${base}/Product/getproductlist`,
    body: kw => JSON.stringify({ keyword: kw, goods_type: [], order: '', page: 1 }),
    parse(json, base) {
      const list = (json.data && Array.isArray(json.data.list)) ? json.data.list : [];
      return list.map(g => {
        const price = [g.true_price, g.price, g.guide_price].find(v => +v > 0) || 0;
        return {
          title: `${g.product_name || ''} ${g.good_name || ''}`.trim().slice(0, 80),
          price: price ? `¥${(+price).toFixed(2)}` : '面议',
          priceNum: +price || 0,
          stock: +g.stock > 0 ? `${g.stock} 件` : '库存充足',
          // 商品详情页路由（从前端源码验证）：/home/productdetail.html?good={good_id}
          url: g.good_id ? `${base}/home/productdetail.html?good=${g.good_id}` : base
        };
      }).filter(it => it.title);
    }
  },

  // ============ 卡卡云（GET 前台搜索页 HTML + 选择器提取，已在真实客户站实测验证） ============
  // 搜索页 GET /pbn.html?key=关键词，结果为服务端渲染 HTML（div.list-2 商品块）。
  卡卡云: {
    label: '卡卡云前台模板',
    type: 'html',
    searchUrl: (base, kw) => `${base}/pbn.html?key=${encodeURIComponent(kw)}`,
    item: 'div.list-2',
    title: '.bt h1 a',
    price: '.right .p2 span',
    stock: '.fenl-1',
    link: 'a[href^="/pg/"]'
  }
};

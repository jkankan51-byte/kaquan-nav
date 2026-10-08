/**
 * PG Worker —— 真正执行 Postgres 查询的线程
 * 协议：主线程 postMessage({reqId, sab, sql, params, forRun}) 或 {migrate:true, ddl}
 *       完成后把 JSON 结果写进共享内存 sab，并用 Atomics.notify 唤醒主线程
 */
const { parentPort, workerData } = require('worker_threads');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// COUNT(*) 等 bigint 以 Number 返回，保持与 node:sqlite 一致
const pg = require('pg');
pg.types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: /render\.com/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined,
});

// ---------- SQLite → Postgres SQL 转换 ----------
function convertSql(sql, forRun) {
  let q = sql;

  // INSERT OR IGNORE → ON CONFLICT DO NOTHING
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(q)) {
    q = q.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    if (!/ON\s+CONFLICT/i.test(q)) q = q.trim().replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }

  // SUM(col=num)（SQLite 布尔表达式求和）
  q = q.replace(/SUM\((\w+)\s*=\s*(\d+)\)/gi,
    (m, c, n) => `SUM(CASE WHEN ${c}=${n} THEN 1 ELSE 0 END)`);

  // datetime('now','localtime') / datetime('now','-7 days','localtime') 等
  q = q.replace(/datetime\(\s*'now'([^)]*)\)/gi, (m, mods) => {
    let interval = '';
    const re = /'([^']*)'/g;
    let mm;
    while ((mm = re.exec(mods))) {
      const mod = mm[1];
      if (/^(localtime|utc)$/i.test(mod)) continue;
      const iv = mod.match(/^([+-]?)\s*(\d+)\s+(day|month|year|hour|minute|second)s?$/i);
      if (iv) {
        const op = iv[1] === '-' ? '-' : '+';
        interval += ` ${op} interval '${iv[2]} ${iv[3].toLowerCase()}s'`;
      }
    }
    return `(to_char(now() AT TIME ZONE 'UTC'${interval}, 'YYYY-MM-DD HH24:MI:SS'))`;
  });

  // AUTOINCREMENT → BIGSERIAL
  q = q.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'BIGSERIAL PRIMARY KEY');

  // 占位符 ? → $n
  let i = 0;
  q = q.replace(/\?/g, () => `$${++i}`);

  // run 模式下 INSERT 附带 RETURNING id 以获得 lastInsertRowid
  // （stats_daily / stats_visitors 没有 id 列，跳过，否则整条语句报错）
  if (forRun && /^INSERT/i.test(q.trim()) && !/RETURNING/i.test(q)) {
    const t = q.match(/INSERT\s+INTO\s+"?(\w+)"?/i);
    if (!t || !/^(stats_daily|stats_visitors|stats_referrers)$/i.test(t[1])) {
      q = q.trim().replace(/;?\s*$/, '') + ' RETURNING id';
    }
  }
  return q;
}

function writeResp(sab, status, jsonStr) {
  const i32 = new Int32Array(sab);
  const bytes = Buffer.from(jsonStr, 'utf8');
  if (bytes.length > sab.byteLength - 8) {
    i32[0] = 2;
    i32[1] = 0;
    const msg = Buffer.from(JSON.stringify({ message: 'result too large' }), 'utf8');
    msg.copy(Buffer.from(sab, 8));
    i32[1] = msg.length;
  } else {
    bytes.copy(Buffer.from(sab, 8));
    i32[1] = bytes.length;
    i32[0] = status;
  }
  Atomics.notify(i32, 0);
}

// ---------- 一次性数据迁移：SQLite 文件 → Postgres（仅当 PG 为空时） ----------
async function doMigrate(ddl) {
  const sqlitePath = workerData.sqlitePath;
  const empty = await pool.query('SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_name=$1', ['sites']);
  const needSchema = empty.rows[0].c === 0;

  if (needSchema) {
    await pool.query(convertSql(ddl, false)); // 多语句 DDL（无参数可用简单查询）
  } else {
    const c = await pool.query('SELECT COUNT(*)::int AS c FROM sites');
    if (c.rows[0].c > 0) return { skipped: 'pg-not-empty' }; // PG 已有数据，不迁移
  }

  if (!sqlitePath || !fs.existsSync(sqlitePath)) return { skipped: 'no-sqlite-file', needSchema };

  const { DatabaseSync } = require('node:sqlite');
  const sdb = new DatabaseSync(sqlitePath);
  const tables = ['sites', 'submissions', 'announcements', 'banners', 'links', 'reports', 'crawl_logs', 'stats_daily', 'stats_visitors', 'stats_total'];
  const imported = {};
  for (const t of tables) {
    const exist = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!exist) continue;
    let rows;
    try { rows = sdb.prepare(`SELECT * FROM ${t}`).all(); } catch (_) { continue; }
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    let n = 0;
    for (const row of rows) {
      const vals = cols.map(c => {
        const v = row[c];
        if (v === undefined) return null;
        if (v instanceof Uint8Array) return Buffer.from(v);
        return v;
      });
      const ph = cols.map(() => '?').join(',');
      try {
        await pool.query(convertSql(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${ph}) ON CONFLICT DO NOTHING`, false), vals);
        n++;
      } catch (e) { /* 单行失败跳过（如主键冲突） */ }
    }
    imported[t] = n;
  }
  // 显式插入 id 后修正自增序列
  for (const t of ['sites', 'submissions', 'announcements', 'banners', 'links', 'reports', 'crawl_logs']) {
    try {
      await pool.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM ${t}), 1))`);
    } catch (_) {}
  }
  return { imported };
}

parentPort.on('message', async (msg) => {
  const { sab, reqId } = msg;
  try {
    let payload;
    if (msg.migrate) {
      payload = await doMigrate(msg.ddl);
    } else {
      const q = convertSql(msg.sql, msg.forRun);
      const r = await pool.query(q, msg.params || []);
      payload = {
        rows: r.rows,
        rowCount: r.rowCount,
        id: r.rows[0] ? (r.rows[0].id ?? null) : null,
      };
    }
    writeResp(sab, 1, JSON.stringify(payload));
  } catch (e) {
    writeResp(sab, 2, JSON.stringify({ message: (e && e.message) || String(e) }));
  }
});

/**
 * Postgres 存储适配器 —— 对外提供与 node:sqlite 完全一致的「同步」API
 * （prepare().get/.all/.run、exec），底层用 Worker 线程 + 共享内存阻塞实现。
 * 这样 server.js / db.js 里的 59 处查询代码无需任何改动即可切换到 Postgres。
 *
 * 启用条件：环境变量 DATABASE_URL 存在（Render 上已配置）。
 * 本地无 DATABASE_URL 时自动回退到 SQLite，不影响本地开发。
 */
const { Worker } = require('worker_threads');
const path = require('path');

const SAB_SIZE = 4 * 1024 * 1024; // 4MB 结果上限

class PgStore {
  constructor() {
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.i32 = new Int32Array(this.sab);
    this.reqId = 0;
    this.worker = new Worker(path.join(__dirname, 'pg-worker.js'), {
      workerData: { sqlitePath: process.env.SQLITE_SOURCE || path.join(__dirname, '..', 'data', 'kaquan.db') },
    });
    this.worker.unref(); // 不阻止进程退出
  }

  _call(msg) {
    const reqId = ++this.reqId;
    Atomics.store(this.i32, 0, 0);
    this.worker.postMessage({ ...msg, sab: this.sab, reqId });
    // 等待 worker 写回结果（单飞行：主线程同步阻塞，同一时刻只有一个请求）
    for (;;) {
      if (Atomics.load(this.i32, 0) !== 0) break;
      const r = Atomics.wait(this.i32, 0, 0, 30000);
      if (r === 'timed-out') throw new Error('PG 查询超时: ' + String(msg.sql || '').slice(0, 80));
    }
    const status = Atomics.load(this.i32, 0);
    const len = Atomics.load(this.i32, 1);
    const payload = JSON.parse(Buffer.from(this.sab, 8, len).toString('utf8'));
    if (status === 2) throw new Error('PG: ' + payload.message);
    return payload;
  }

  prepare(sql) {
    const self = this;
    const head = sql.trim().slice(0, 6).toUpperCase();
    const isWrite = head === 'INSERT' || sql.trim().slice(0, 6).toUpperCase() === 'UPDATE' || sql.trim().slice(0, 6).toUpperCase() === 'DELETE';
    return {
      get: (...params) => self._call({ sql, params }).rows[0],
      all: (...params) => self._call({ sql, params }).rows,
      run: (...params) => {
        const r = self._call({ sql, params, forRun: isWrite });
        return { changes: r.rowCount, lastInsertRowid: r.id };
      },
    };
  }

  exec(sql) {
    this._call({ sql, params: [] });
  }

  migrateSync(ddl) {
    return this._call({ migrate: true, ddl });
  }
}

module.exports = new PgStore();

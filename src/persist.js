/**
 * 数据库持久化：把 SQLite 文件实时同步回 GitHub 仓库，
 * 解决 Render 免费档容器每次部署清空数据的问题。
 *
 * 原理：
 *  - 启动后先从 GitHub pull 最新提交的 db（拿到其他部署写入的数据）
 *  - 之后每 60 秒检测 db 文件是否变化，变了就 commit + push
 *  - 进程收到 SIGTERM（Render 部署/关停前）再做一次最终同步
 *
 * 需要环境变量 GITHUB_PUSH_TOKEN（具有 repo 权限的 PAT）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DB = path.join(REPO, 'data', 'kaquan.db');
const TOKEN = process.env.GITHUB_PUSH_TOKEN || '';
const OWNER = 'jkankan51-byte';
const REPO_NAME = 'kaquan-nav';
const BRANCH = 'main';
const REMOTE = `https://${OWNER}:${TOKEN}@github.com/${OWNER}/${REPO_NAME}.git`;

let lastMtime = 0;
let timer = null;

function git(args) {
  // 绕过 Git for Windows 的凭据选择器（避免 push 卡住）；Linux(Render) 上无此工具，参数无害
  const full = ['-c', 'credential.helper=', '-c', 'credential.helperselector=', ...args];
  execFileSync('git', full, { cwd: REPO, stdio: 'ignore', timeout: 30000 });
}

function configure() {
  try {
    git(['config', '--global', 'safe.directory', '*']);
    git(['config', '--global', 'user.email', 'bot@offclock.top']);
    git(['config', '--global', 'user.name', 'offclock-bot']);
    if (TOKEN) git(['remote', 'set-url', 'origin', REMOTE]);
  } catch (_) {}
}

function pull() {
  if (!TOKEN) return;
  try { git(['pull', '--rebase', '--autostash', 'origin', BRANCH]); } catch (_) {}
}

// 进程启动最早期调用：先把 GitHub 上最新的 db 拉回本地磁盘，再让 db.js 打开它
function bootstrap() {
  if (!TOKEN) {
    console.log('⚠️ 未配置 GITHUB_PUSH_TOKEN，数据库不会自动同步（每次部署清空）');
    return;
  }
  configure();
  pull();
}

function push() {
  if (!TOKEN) return false;
  try {
    // WAL 模式下数据可能在 -wal 文件，先落盘到主库再提交
    try { require('./db').exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    if (!fs.existsSync(DB)) return false;
    const m = fs.statSync(DB).mtimeMs;
    if (m === lastMtime) return false; // 无变化
    git(['add', '-f', 'data/kaquan.db', 'data/kaquan.db-wal', 'data/kaquan.db-shm']);
    git(['commit', '-m', 'chore: auto-sync db ' + new Date().toISOString()]);
    git(['push', 'origin', BRANCH]);
    lastMtime = m;
    console.log('✅ 数据库已同步回 GitHub');
    return true;
  } catch (_) {
    return false; // 忽略：可能无变化或网络抖动
  }
}

function start() {
  if (!TOKEN) {
    return;
  }
  // bootstrap 已在进程早期执行过 pull；这里只需启动定时同步
  try { lastMtime = fs.statSync(DB).mtimeMs; } catch (_) {}
  timer = setInterval(push, 60000);
  if (timer.unref) timer.unref();

  const flush = () => { try { push(); } catch (_) {} };
  process.on('SIGTERM', () => { flush(); });
  process.on('SIGINT', () => { flush(); });
  console.log('✅ 数据库自动同步已启用（GITHUB_PUSH_TOKEN）');
}

module.exports = { bootstrap, start, push };

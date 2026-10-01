// 真实 SQL 持久化（sql.js / SQLite）。保存：模板与版本、变量定义、数据快照、渲染任务、脱敏任务日志。
import initSqlJs from 'sql.js'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

const require = createRequire(import.meta.url)
const distDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'))
const DB_FILE = process.env.CATALPA_DB || path.join(process.cwd(), 'server', 'data', 'app.sqlite')

let _db

const SCHEMA = `
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS template_versions (
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
);
CREATE TABLE IF NOT EXISTS variable_defs (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT,
  type TEXT NOT NULL,
  expr TEXT,
  default_value TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  tz TEXT,
  format INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  data TEXT NOT NULL,       -- 冻结取数结果 JSON（单次取数）
  acl TEXT NOT NULL,        -- { principal, deniedPaths }
  zone TEXT NOT NULL,
  source_epochs TEXT,       -- 各数据源版本/更新时间，用于说明快照边界
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS render_tasks (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  snapshot_id TEXT,         -- 成功取数后固定；未取数前为 NULL
  principal TEXT NOT NULL,
  status TEXT NOT NULL,     -- waiting_data | pending | running | succeeded | failed | template_stale
  attempt INTEGER NOT NULL DEFAULT 0,
  result TEXT,              -- 成功产物 JSON
  error TEXT,               -- 失败诊断 JSON
  share_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL    -- 写入前已脱敏的 JSON
);
CREATE INDEX IF NOT EXISTS idx_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON render_tasks(status);
`

export async function getDb() {
  if (_db) return _db
  const SQL = await initSqlJs({ locateFile: (f) => path.join(distDir, f) })
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
  if (fs.existsSync(DB_FILE)) {
    _db = new SQL.Database(fs.readFileSync(DB_FILE))
  } else {
    _db = new SQL.Database()
  }
  _db.run(SCHEMA)
  await persist()
  return _db
}

let saveTimer = null
export function persist() {
  return new Promise((resolve) => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      fs.writeFileSync(DB_FILE, Buffer.from(_db.export()))
      resolve()
    }, 10)
  })
}
export async function persistNow() {
  clearTimeout(saveTimer)
  fs.writeFileSync(DB_FILE, Buffer.from(_db.export()))
}

// ---- 小工具 ----
export function all(sql, params = []) {
  const stmt = _db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}
export function one(sql, params = []) {
  return all(sql, params)[0] || null
}
export function run(sql, params = []) {
  _db.run(sql, params)
  return persist()
}

// ============================================================
// Database – sql.js (pure-JS SQLite, no native compilation)
// ============================================================
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'gpw.db');
let _db = null;
let _SQL = null;

async function initDb() {
  if (_db) return _db;

  _SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    _db = new _SQL.Database(buffer);
  } else {
    _db = new _SQL.Database();
  }

  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

function saveDb() {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function closeDb() {
  if (_db) {
    saveDb();
    _db.close();
    _db = null;
  }
}

// Save periodically and on process exit
let _saveInterval = null;
function startAutoSave(intervalMs = 30000) {
  if (_saveInterval) return;
  _saveInterval = setInterval(() => { try { saveDb(); } catch {} }, intervalMs);
  process.on('exit', () => { try { closeDb(); } catch {} });
  process.on('SIGINT', () => { try { closeDb(); } catch {} process.exit(0); });
}

// ---- sql.js helper: run SELECT and return array of objects ----
function query(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// ---- sql.js helper: run SELECT and return first row or null ----
function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ---- sql.js helper: run INSERT/UPDATE/DELETE ----
function run(sql, params = []) {
  const db = getDb();
  db.run(sql, params);
  return db.getRowsModified();
}

module.exports = { initDb, getDb, saveDb, closeDb, startAutoSave, query, queryOne, run, DB_PATH };

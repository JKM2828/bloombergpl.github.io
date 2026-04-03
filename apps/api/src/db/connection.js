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

let _lastSaveOk = null;
let _lastSaveError = null;
let _saveFailCount = 0;

function saveDb() {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  _lastSaveOk = new Date().toISOString();
  _saveFailCount = 0;
}

function closeDb() {
  if (_db) {
    saveDb();
    _db.close();
    _db = null;
  }
}

function getDbHealth() {
  return {
    initialized: !!_db,
    dbPath: DB_PATH,
    lastSaveOk: _lastSaveOk,
    lastSaveError: _lastSaveError,
    saveFailCount: _saveFailCount,
    fileSizeBytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
  };
}

// Save periodically and on process exit
let _saveInterval = null;
function startAutoSave(intervalMs = 30000) {
  if (_saveInterval) return;
  _saveInterval = setInterval(() => {
    try { saveDb(); }
    catch (err) {
      _saveFailCount++;
      _lastSaveError = { message: err.message, at: new Date().toISOString() };
      console.error(`[db] Auto-save failed (count=${_saveFailCount}):`, err.message);
    }
  }, intervalMs);
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

module.exports = { initDb, getDb, saveDb, closeDb, startAutoSave, query, queryOne, run, DB_PATH, getDbHealth };

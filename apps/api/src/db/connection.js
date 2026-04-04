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
let _saving = false;
let _savePending = false;
let _saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 5000; // PERF-H2: max one disk write per 5s

/**
 * Async atomic write — write to .tmp then rename.
 * Used by debounced path and auto-save.
 */
async function _persistAsync() {
  if (!_db) return;
  if (_saving) { _savePending = true; return; }
  _saving = true;
  _savePending = false;
  try {
    const data = _db.export();
    const buffer = Buffer.from(data);
    const tmpPath = DB_PATH + '.tmp';
    await fs.promises.writeFile(tmpPath, buffer);
    await fs.promises.rename(tmpPath, DB_PATH);
    _lastSaveOk = new Date().toISOString();
    _saveFailCount = 0;
  } catch (err) {
    _saveFailCount++;
    _lastSaveError = { message: err.message, at: new Date().toISOString() };
    console.error(`[db] Async save failed (count=${_saveFailCount}):`, err.message);
  } finally {
    _saving = false;
    if (_savePending) _persistAsync().catch(() => {});
  }
}

/**
 * PERF-H2: Debounced fire-and-forget save.
 * Schedules an async write at most once per SAVE_DEBOUNCE_MS.
 * Safe to call frequently (e.g. after every portfolio transaction).
 */
function saveDb() {
  if (!_db) return;
  if (_saveDebounceTimer) return; // already scheduled
  _saveDebounceTimer = setTimeout(() => {
    _saveDebounceTimer = null;
    _persistAsync().catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Synchronous save — only used during process shutdown (SIGTERM/SIGINT closeDb).
 */
function _saveDbSync() {
  if (!_db) return;
  try {
    const data = _db.export();
    const buffer = Buffer.from(data);
    const tmpPath = DB_PATH + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, DB_PATH);
    _lastSaveOk = new Date().toISOString();
    _saveFailCount = 0;
  } catch (err) {
    _saveFailCount++;
    _lastSaveError = { message: err.message, at: new Date().toISOString() };
    console.error(`[db] Sync save failed:`, err.message);
  }
}

function closeDb() {
  if (_saveDebounceTimer) { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
  if (_db) {
    _saveDbSync();
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
    _persistAsync().catch(err => {
      _saveFailCount++;
      _lastSaveError = { message: err.message, at: new Date().toISOString() };
      console.error(`[db] Auto-save failed (count=${_saveFailCount}):`, err.message);
    });
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

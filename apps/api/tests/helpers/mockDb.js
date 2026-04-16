// ============================================================
// Mock DB layer for unit tests
// Replaces ../db/connection with in-memory maps
//
// Separate stacks for query() and queryOne() to avoid
// interleaving issues when source code mixes both call types.
// ============================================================
const _tables = {};
let _queryResults = [];
let _queryOneResult = null;
const _queryStack = [];
const _queryOneStack = [];
let _queryCallCount = 0;
let _queryOneCallCount = 0;

function reset() {
  _queryResults = [];
  _queryOneResult = null;
  _queryStack.length = 0;
  _queryOneStack.length = 0;
  _queryCallCount = 0;
  _queryOneCallCount = 0;
  for (const k of Object.keys(_tables)) delete _tables[k];
}

function setQueryResults(rows) { _queryResults = rows; }
function setQueryOneResult(row) { _queryOneResult = row; }

function pushQueryResult(rows) { _queryStack.push(rows); }
function pushQueryOneResult(row) { _queryOneStack.push(row); }

function query(_sql, _params) {
  _queryCallCount++;
  if (_queryStack.length > 0) return _queryStack.shift();
  return _queryResults;
}

function queryOne(_sql, _params) {
  _queryOneCallCount++;
  if (_queryOneStack.length > 0) return _queryOneStack.shift();
  return _queryOneResult;
}

function getStats() {
  return {
    queryCalls: _queryCallCount,
    queryOneCalls: _queryOneCallCount,
  };
}

function run(_sql, _params) { return { changes: 0 }; }
function saveDb() {}

module.exports = {
  query, queryOne, run, saveDb,
  reset, setQueryResults, setQueryOneResult,
  pushQueryResult, pushQueryOneResult,
  getStats,
  _tables,
};

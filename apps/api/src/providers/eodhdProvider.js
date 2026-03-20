// ============================================================
// EODHD provider – paid/free EOD data for GPW (Warsaw Exchange)
//
// API docs: https://eodhd.com/financial-apis/api-for-historical-data-and-volumes
// GPW stocks use .WAR suffix, indices use .INDX suffix.
//
// Auth: API key via env EODHD_API_KEY (or 'demo' for testing).
// Free demo key: ~20 calls/day. Paid ($20/mo+): unlimited EOD.
//
// Covers: stocks, ETFs, indices. Futures coverage is limited.
// ============================================================
const https = require('https');
const { createCandle } = require('../../../../packages/shared/src');

const EODHD_BASE = 'https://eodhd.com/api';

// ---- API key ----
function getApiKey() {
  return process.env.EODHD_API_KEY || 'demo';
}

// ---- Daily request counter & budget ----
const DAILY_LIMIT = parseInt(process.env.EODHD_MAX_DAILY_REQUESTS || '20', 10);
let dailyRequestCount = 0;
let requestCountDate = null;

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (requestCountDate !== today) {
    dailyRequestCount = 0;
    requestCountDate = today;
  }
}

function hasBudget() {
  resetDailyCounterIfNeeded();
  return dailyRequestCount < DAILY_LIMIT;
}

function getRequestStats() {
  resetDailyCounterIfNeeded();
  return {
    dailyRequestCount,
    dailyLimit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - dailyRequestCount),
    apiKey: getApiKey() === 'demo' ? 'demo' : 'configured',
  };
}

// ---- Health check cache ----
let cachedHealthResult = null;
let cachedHealthTime = 0;
const HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;

// ============================================================
// Ticker mapping: internal GPW ticker → EODHD symbol
//
// EODHD convention:
//   Stocks on Warsaw   → TICKER.WAR    (e.g. PKN.WAR, CDR.WAR)
//   GPW Indices        → TICKER.INDX   (e.g. WIG.INDX, WIG20.INDX)
//   ETFs on Warsaw     → TICKER.WAR    (same as stocks)
//   Futures            → limited/no coverage (fallback elsewhere)
// ============================================================
const EODHD_TICKER_MAP = {
  // Indices – use .INDX exchange
  WIG:    'WIG.INDX',
  WIG20:  'WIG20.INDX',
  MWIG40: 'MWIG40.INDX',
  SWIG80: 'SWIG80.INDX',
  // Stocks with digit-prefixed tickers
  '11B':  '11B.WAR',
  '1AT':  '1AT.WAR',
  // ETFs – EODHD may list them under .WAR
  ETFBW20TR: 'ETFBW20TR.WAR',
  ETFBW20ST: 'ETFBW20ST.WAR',
  ETFBW20LV: 'ETFBW20LV.WAR',
  ETFSP500:  'ETFSP500.WAR',
  ETFDAX:    'ETFDAX.WAR',
  ETFBS80TR: 'ETFBS80TR.WAR',
  ETFBNDXPL: 'ETFBNDXPL.WAR',
  ETFBNQ2ST: 'ETFBNQ2ST.WAR',
  ETFBNQ3LV: 'ETFBNQ3LV.WAR',
  ETFBSPXPL: 'ETFBSPXPL.WAR',
  ETFBTBSP:  'ETFBTBSP.WAR',
  ETFBTCPL:  'ETFBTCPL.WAR',
  ETFNATO:   'ETFNATO.WAR',
};

// Tickers that EODHD does NOT reliably cover
const EODHD_UNSUPPORTED = new Set([
  'FW20', 'FW40', // GPW futures – not on EODHD
]);

/**
 * Resolve internal ticker to EODHD symbol.
 * Default: TICKER.WAR (Warsaw Exchange)
 */
function resolveEodhdSymbol(ticker) {
  if (EODHD_UNSUPPORTED.has(ticker)) return null;
  return EODHD_TICKER_MAP[ticker] || `${ticker}.WAR`;
}

// ---- HTTP helper ----
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'GPW-Bloomberg/1.0 (research)',
        'Accept': 'application/json',
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const err = new Error('EODHD rate limit exceeded');
          err.code = 'EODHD_RATE_LIMIT';
          return reject(err);
        }
        if (res.statusCode === 402) {
          const err = new Error('EODHD API key limit — upgrade required');
          err.code = 'EODHD_PAYMENT_REQUIRED';
          return reject(err);
        }
        if (res.statusCode === 403) {
          const err = new Error('EODHD 403 Forbidden — API key invalid or GPW exchange not included in plan');
          err.code = 'EODHD_FORBIDDEN';
          return reject(err);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`EODHD HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`EODHD JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('EODHD request timeout')); });
  });
}

/**
 * Check if EODHD is available (has valid API key configured).
 * Demo key only works for US symbols, not GPW.
 */
function isAvailable() {
  const key = getApiKey();
  if (!key || key === 'demo') return false;
  resetDailyCounterIfNeeded();
  return dailyRequestCount < DAILY_LIMIT;
}

/**
 * Fetch OHLCV candles from EODHD for a given ticker.
 * @param {string} ticker – Internal GPW ticker (e.g. 'PKN', 'CDR', 'WIG20')
 * @param {string} dateFrom – 'YYYYMMDD'
 * @param {string} dateTo   – 'YYYYMMDD'
 * @returns {Promise<Array>} array of candle objects
 */
async function fetchCandles(ticker, dateFrom, dateTo) {
  // Demo key doesn't work for GPW — skip to avoid wasting calls
  if (getApiKey() === 'demo' || !getApiKey()) {
    const err = new Error('EODHD requires a paid API key for GPW data (set EODHD_API_KEY env)');
    err.code = 'EODHD_NO_KEY';
    throw err;
  }

  // Hard daily budget guard
  if (!hasBudget()) {
    const err = new Error(`EODHD daily limit reached (${DAILY_LIMIT} calls/day)`);
    err.code = 'EODHD_BUDGET_EXHAUSTED';
    throw err;
  }

  const eodhdSymbol = resolveEodhdSymbol(ticker);
  if (!eodhdSymbol) {
    const err = new Error(`EODHD does not support ${ticker} (futures)`);
    err.code = 'EODHD_UNSUPPORTED';
    throw err;
  }

  const apiKey = getApiKey();
  // Format dates: YYYYMMDD → YYYY-MM-DD
  const from = `${dateFrom.slice(0, 4)}-${dateFrom.slice(4, 6)}-${dateFrom.slice(6, 8)}`;
  const to = `${dateTo.slice(0, 4)}-${dateTo.slice(4, 6)}-${dateTo.slice(6, 8)}`;

  const url = `${EODHD_BASE}/eod/${encodeURIComponent(eodhdSymbol)}?api_token=${apiKey}&fmt=json&from=${from}&to=${to}`;

  resetDailyCounterIfNeeded();
  dailyRequestCount++;

  const json = await httpsGetJson(url);

  // EODHD returns an array of { date, open, high, low, close, adjusted_close, volume }
  if (!Array.isArray(json) || json.length === 0) {
    return [];
  }

  const candles = [];
  for (const bar of json) {
    if (!bar.date || bar.close == null || bar.close <= 0) continue;
    candles.push(createCandle(
      bar.date,                    // already YYYY-MM-DD
      +(bar.open || bar.close),
      +(bar.high || bar.close),
      +(bar.low || bar.close),
      +bar.close,
      +(bar.volume || 0)
    ));
  }

  return candles;
}

/**
 * Health check – try fetching PKN (most liquid GPW stock) from EODHD.
 * Returns immediately if no valid API key is configured.
 */
async function healthCheck() {
  if (!isAvailable()) {
    return { ok: false, provider: 'eodhd', error: 'No API key (set EODHD_API_KEY)', ...getRequestStats() };
  }

  // Return cached result if fresh
  if (cachedHealthResult && (Date.now() - cachedHealthTime) < HEALTH_CACHE_TTL_MS) {
    return { ...cachedHealthResult, cached: true, ...getRequestStats() };
  }

  try {
    const dateTo = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dateFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const candles = await fetchCandles('PKN', dateFrom, dateTo);
    const result = { ok: candles.length > 0, provider: 'eodhd', candles: candles.length };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  } catch (err) {
    const result = { ok: false, provider: 'eodhd', error: err.message };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  }
}

module.exports = {
  name: 'eodhd',
  fetchCandles,
  healthCheck,
  getRequestStats,
  isAvailable,
  resolveEodhdSymbol,
  EODHD_UNSUPPORTED,
};

// ============================================================
// Yahoo Finance provider – FREE backup for GPW stocks & ETFs
//
// Uses the unofficial v8 chart API (no API key required).
// Tickers use .WA suffix for Warsaw Stock Exchange.
// Covers: stocks, ETFs. Does NOT cover GPW indices or futures.
// ============================================================
const https = require('https');
const { createCandle } = require('../../../../packages/shared/src');

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

// ---- Simple daily request counter (monitoring only) ----
let dailyRequestCount = 0;
let requestCountDate = null;

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (requestCountDate !== today) {
    dailyRequestCount = 0;
    requestCountDate = today;
  }
}

function getRequestStats() {
  resetDailyCounterIfNeeded();
  return { dailyRequestCount };
}

// ---- Health check cache ----
let cachedHealthResult = null;
let cachedHealthTime = 0;
const HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;

// ============================================================
// Ticker mapping: internal GPW ticker → Yahoo symbol
// ============================================================

// These tickers don't exist or differ on Yahoo Finance
const YAHOO_TICKER_MAP = {
  // Stocks with digit-prefixed tickers
  '11B': '11B.WA',
  '1AT': '1AT.WA',
  // ETFs – Beta ETF on Yahoo also use .WA suffix
  ETFBW20TR: 'ETFBW20TR.WA',
  ETFBW20ST: 'ETFBW20ST.WA',
  ETFBW20LV: 'ETFBW20LV.WA',
  ETFSP500:  'ETFSP500.WA',
  ETFDAX:    'ETFDAX.WA',
  ETFBS80TR: 'ETFBS80TR.WA',
  ETFBNDXPL: 'ETFBNDXPL.WA',
  ETFBNQ2ST: 'ETFBNQ2ST.WA',
  ETFBNQ3LV: 'ETFBNQ3LV.WA',
  ETFBSPXPL: 'ETFBSPXPL.WA',
  ETFBTBSP:  'ETFBTBSP.WA',
  ETFBTCPL:  'ETFBTCPL.WA',
  ETFNATO:   'ETFNATO.WA',
};

// Tickers that Yahoo does NOT cover (indices, futures)
const YAHOO_UNSUPPORTED = new Set([
  'WIG', 'WIG20', 'MWIG40', 'SWIG80',  // indices
  'FW20', 'FW40',                         // futures
]);

/**
 * Resolve internal ticker to Yahoo Finance symbol.
 * Most GPW stocks: TICKER → TICKER.WA
 */
function resolveYahooSymbol(ticker) {
  if (YAHOO_UNSUPPORTED.has(ticker)) return null;
  return YAHOO_TICKER_MAP[ticker] || `${ticker}.WA`;
}

/**
 * Make an HTTPS GET request and return parsed JSON.
 * Uses native https to avoid axios dependency issues.
 */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Yahoo HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Yahoo JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Yahoo request timeout')); });
  });
}

/**
 * Fetch OHLCV candles from Yahoo Finance for a given ticker.
 * @param {string} ticker – Internal GPW ticker (e.g. 'PKN', 'CDR')
 * @param {string} dateFrom – 'YYYYMMDD'
 * @param {string} dateTo   – 'YYYYMMDD'
 * @returns {Promise<Array>} array of candle objects
 */
async function fetchCandles(ticker, dateFrom, dateTo) {
  const yahooSymbol = resolveYahooSymbol(ticker);
  if (!yahooSymbol) {
    // Unsupported ticker type (index/futures)
    const err = new Error(`Yahoo does not support ${ticker} (index/futures)`);
    err.code = 'YAHOO_UNSUPPORTED';
    throw err;
  }

  // Convert YYYYMMDD → Unix timestamp
  const period1 = dateToUnix(dateFrom);
  const period2 = dateToUnix(dateTo) + 86400; // include end date

  const url = `${YAHOO_BASE}${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;

  resetDailyCounterIfNeeded();
  dailyRequestCount++;

  const json = await httpsGetJson(url);

  // Check for API errors
  if (json.chart && json.chart.error) {
    throw new Error(`Yahoo API error for ${ticker}: ${json.chart.error.description || 'Unknown'}`);
  }

  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp || result.timestamp.length === 0) {
    return []; // No data
  }

  return parseYahooChart(result, ticker);
}

/**
 * Parse Yahoo Finance chart response into candle objects.
 */
function parseYahooChart(result, ticker) {
  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!quote) return [];

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i] || 0;

    // Skip null values (market closed days)
    if (open == null || high == null || low == null || close == null) continue;
    if (isNaN(close) || close <= 0) continue;

    // Convert Unix timestamp to YYYY-MM-DD
    const date = unixToDate(timestamps[i]);
    candles.push(createCandle(date, +open.toFixed(4), +high.toFixed(4), +low.toFixed(4), +close.toFixed(4), volume));
  }

  return candles;
}

/**
 * Convert YYYYMMDD string to Unix timestamp (seconds).
 */
function dateToUnix(yyyymmdd) {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return Math.floor(new Date(`${y}-${m}-${d}T00:00:00Z`).getTime() / 1000);
}

/**
 * Convert Unix timestamp (seconds) to YYYY-MM-DD.
 */
function unixToDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Health check – try fetching PKN (most liquid GPW stock) from Yahoo.
 */
async function healthCheck() {
  // Return cached result if fresh
  if (cachedHealthResult && (Date.now() - cachedHealthTime) < HEALTH_CACHE_TTL_MS) {
    return { ...cachedHealthResult, cached: true, ...getRequestStats() };
  }

  try {
    const dateTo = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dateFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const candles = await fetchCandles('PKN', dateFrom, dateTo);
    const result = { ok: candles.length > 0, provider: 'yahoo', candles: candles.length };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  } catch (err) {
    const result = { ok: false, provider: 'yahoo', error: err.message };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  }
}

module.exports = {
  name: 'yahoo',
  fetchCandles,
  healthCheck,
  getRequestStats,
  resolveYahooSymbol,
  YAHOO_UNSUPPORTED,
};

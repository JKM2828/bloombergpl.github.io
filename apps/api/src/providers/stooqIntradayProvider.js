// ============================================================
// Stooq Intraday Provider – fetches 1h candles from Stooq CSV
//
// Stooq supports intraday intervals via &i= parameter:
//   i=d (daily), i=w (weekly), i=m (monthly)
//   i=5  (5 min), i=15 (15 min), i=60 (1 hour)
//
// FREE tier: limited history (~30-60 days for 1h);
//   we use 60-min bars as the default intraday resolution.
//
// Rate limits shared with stooqProvider (same domain).
// ============================================================
const axios = require('axios');
const { createCandle } = require('../../../../packages/shared/src');

const STOOQ_BASE = 'https://stooq.pl/q/d/l/';

// Reuse rate-limit + ticker mapping from main stooq provider
const stooqMain = require('./stooqProvider');

/**
 * Fetch 1-hour OHLCV candles from Stooq for a given ticker.
 * @param {string} ticker – Internal GPW ticker
 * @param {string} dateFrom – 'YYYYMMDD'
 * @param {string} dateTo   – 'YYYYMMDD'
 * @returns {Promise<Array>} array of candle objects with datetime keys
 */
async function fetchIntraday(ticker, dateFrom, dateTo) {
  // Check rate-limit state via main provider
  const rl = stooqMain.getRateLimitState();
  if (rl.active) {
    const err = new Error(`Stooq rate-limited until ${rl.cooldownUntil}`);
    err.code = 'STOOQ_RATE_LIMIT';
    throw err;
  }

  const stats = stooqMain.getRequestStats();
  if (stats.remaining <= 0) {
    const err = new Error('Stooq daily limit exhausted');
    err.code = 'STOOQ_RATE_LIMIT';
    throw err;
  }

  const stooqSymbol = resolveStooqSymbol(ticker);
  // i=60 for 1-hour bars
  const url = `${STOOQ_BASE}?s=${stooqSymbol}&d1=${dateFrom}&d2=${dateTo}&i=60`;

  const response = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'GPW-Bloomberg/1.0 (research)' },
    responseType: 'text',
  });

  // Detect rate-limit
  const norm = String(response.data || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (norm.includes('przekroczony dzienny limit wywolan')) {
    const err = new Error('Stooq daily limit hit (intraday)');
    err.code = 'STOOQ_RATE_LIMIT';
    throw err;
  }

  return parseCsvIntraday(response.data, ticker);
}

/**
 * Parse Stooq intraday CSV.
 * Format: Date,Time,Open,High,Low,Close,Volume
 * or:     Date,Open,High,Low,Close,Volume (with datetime in Date field)
 */
function parseCsvIntraday(csv, ticker) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  const hasTime = header.includes('time') || header.includes('czas');
  const hasVolume = header.includes('volume') || header.includes('wolumen');

  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;

    let dateStr, timeStr, open, high, low, close, volume;

    if (hasTime && parts.length >= 7) {
      // Date,Time,Open,High,Low,Close,Volume
      dateStr = parts[0];
      timeStr = parts[1];
      open = parseFloat(parts[2]);
      high = parseFloat(parts[3]);
      low = parseFloat(parts[4]);
      close = parseFloat(parts[5]);
      volume = hasVolume ? parseInt(parts[6], 10) || 0 : 0;
    } else {
      // Date,Open,High,Low,Close,Volume (datetime packed in date field)
      dateStr = parts[0];
      timeStr = null;
      open = parseFloat(parts[1]);
      high = parseFloat(parts[2]);
      low = parseFloat(parts[3]);
      close = parseFloat(parts[4]);
      volume = hasVolume && parts[5] ? parseInt(parts[5], 10) || 0 : 0;
    }

    if (isNaN(close) || close <= 0) continue;

    // Normalize date to YYYY-MM-DD HH:MM format
    const date = normalizeIntradayDate(dateStr, timeStr);
    if (!date) continue;

    candles.push({ ...createCandle(date, open, high, low, close, volume) });
  }

  return candles;
}

/**
 * Normalize date + optional time into 'YYYY-MM-DD HH:MM' format.
 */
function normalizeIntradayDate(dateStr, timeStr) {
  let datePart;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    datePart = dateStr.slice(0, 10);
  } else if (/^\d{8}/.test(dateStr)) {
    datePart = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  } else {
    return null;
  }

  let timePart = '00:00';
  if (timeStr) {
    // Handle HHMM or HH:MM
    const t = timeStr.trim();
    if (/^\d{4}$/.test(t)) {
      timePart = `${t.slice(0, 2)}:${t.slice(2, 4)}`;
    } else if (/^\d{2}:\d{2}/.test(t)) {
      timePart = t.slice(0, 5);
    }
  } else if (dateStr.length > 10) {
    // Time embedded in date field: "2026-03-08 14:00"
    const rest = dateStr.slice(10).trim();
    if (/\d{2}:\d{2}/.test(rest)) {
      timePart = rest.slice(0, 5);
    }
  }

  return `${datePart} ${timePart}`;
}

// ---- Ticker mapping (shared logic) ----
const STOOQ_TICKER_MAP = {
  ETFBW20TR: 'etfbw20tr.pl', ETFBW20ST: 'etfbw20st.pl', ETFBW20LV: 'etfbw20lv.pl',
  ETFSP500: 'etfsp500.pl', ETFDAX: 'etfdax.pl', ETFBS80TR: 'etfbs80tr.pl',
  ETFBNDXPL: 'etfbndxpl.pl', ETFBNQ2ST: 'etfbnq2st.pl', ETFBNQ3LV: 'etfbnq3lv.pl',
  ETFBSPXPL: 'etfbspxpl.pl', ETFBTBSP: 'etfbtbsp.pl', ETFBTCPL: 'etfbtcpl.pl',
  ETFNATO: 'etfnato.pl', '11B': '11b', '1AT': '1at',
};

function resolveStooqSymbol(ticker) {
  return STOOQ_TICKER_MAP[ticker] || ticker.toLowerCase();
}

module.exports = {
  name: 'stooq-intraday',
  fetchIntraday,
  parseCsvIntraday,
};

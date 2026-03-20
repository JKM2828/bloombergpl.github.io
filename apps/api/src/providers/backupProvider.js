// ============================================================
// Backup data provider – uses stooq.com (international mirror)
// Falls back on alternative CSV endpoint patterns.
// ============================================================
const axios = require('axios');
const { createCandle } = require('../../../../packages/shared/src');

const BACKUP_BASE = 'https://stooq.com/q/d/l/';

/**
 * Fetch OHLCV candles from the international Stooq mirror.
 */
async function fetchCandles(ticker, dateFrom, dateTo) {
  // International mirror uses slightly different ticker suffixes for GPW
  const stooqTicker = `${ticker.toLowerCase()}.pl`;
  const url = `${BACKUP_BASE}?s=${stooqTicker}&d1=${dateFrom}&d2=${dateTo}&i=d`;

  const response = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'GPW-Bloomberg/1.0 (research)' },
    responseType: 'text',
  });

  return parseCsv(response.data);
}

function parseCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;

    const [dateStr, openStr, highStr, lowStr, closeStr, volStr] = parts;
    const open = parseFloat(openStr);
    const high = parseFloat(highStr);
    const low = parseFloat(lowStr);
    const close = parseFloat(closeStr);
    const volume = volStr ? parseInt(volStr, 10) : 0;

    if (isNaN(close)) continue;

    let date = dateStr;
    if (/^\d{8}$/.test(date)) date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

    candles.push(createCandle(date, open, high, low, close, volume));
  }

  return candles;
}

async function healthCheck() {
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const candles = await fetchCandles('WIG', from, today);
    return { ok: candles.length > 0, provider: 'backup', candles: candles.length };
  } catch (err) {
    return { ok: false, provider: 'backup', error: err.message };
  }
}

module.exports = {
  name: 'backup',
  fetchCandles,
  healthCheck,
};

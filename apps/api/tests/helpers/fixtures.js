// ============================================================
// Test helper: generate synthetic candle data
// ============================================================
function generateCandles(count, opts = {}) {
  const basePrice = opts.basePrice || 100;
  const baseVolume = opts.baseVolume || 100000;
  const trend = opts.trend || 0; // daily % drift
  const volatility = opts.volatility || 0.02;
  const startDate = opts.startDate || '2025-01-01';

  const candles = [];
  let price = basePrice;
  const start = new Date(startDate);

  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    // Skip weekends
    while (date.getDay() === 0 || date.getDay() === 6) {
      date.setDate(date.getDate() + 1);
    }

    const drift = 1 + trend + (Math.random() - 0.5) * volatility * 2;
    price = price * drift;

    const open = price * (1 + (Math.random() - 0.5) * volatility);
    const close = price;
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);
    const volume = Math.round(baseVolume * (0.5 + Math.random()));

    candles.push({
      date: date.toISOString().split('T')[0],
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
    });
  }

  return candles;
}

/**
 * Generate a rising trend candle set (for testing bullish signals)
 */
function generateBullishCandles(count = 250) {
  return generateCandles(count, { trend: 0.001, volatility: 0.015, basePrice: 50 });
}

/**
 * Generate a falling trend candle set (for testing bearish signals)
 */
function generateBearishCandles(count = 250) {
  return generateCandles(count, { trend: -0.001, volatility: 0.015, basePrice: 100 });
}

/**
 * Generate flat / sideways candles
 */
function generateFlatCandles(count = 250) {
  return generateCandles(count, { trend: 0, volatility: 0.01, basePrice: 75 });
}

module.exports = { generateCandles, generateBullishCandles, generateBearishCandles, generateFlatCandles };

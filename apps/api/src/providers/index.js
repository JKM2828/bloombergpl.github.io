// ============================================================
// Provider manager – Multi-source with automatic failover
//
// Priority chain (5-tier):
//   1. GPW API (primary – all instruments, daily + intraday)
//   2. Stooq JSON batch (chunked, ~real-time, retry-missing)
//   3. Stooq CSV (historical, 180/day soft limit)
//   4. EODHD (stocks, ETFs, indices – paid/free API key)
//   5. Yahoo Finance (stocks+ETFs only, no indices/futures)
//
// Asset-class aware fallback:
//   stocks/ETFs  → all 5 providers
//   indices      → GPW → Stooq JSON/CSV → EODHD (Yahoo unsupported)
//   futures      → GPW → Stooq JSON/CSV only (EODHD+Yahoo unsupported)
//
// Also provides batch fetch for ingest (chunked HTTP calls)
// ============================================================
const gpwProvider = require('./gpwProvider');
const stooqProvider = require('./stooqProvider');
const stooqJsonProvider = require('./stooqJsonProvider');
const eodhdProvider = require('./eodhdProvider');
const yahooProvider = require('./yahooProvider');

const providers = [gpwProvider, stooqJsonProvider, stooqProvider, eodhdProvider, yahooProvider];

// ============================================================
// GLOBAL DAILY BUDGET TRACKER
// Tracks total HTTP calls across ALL providers per day.
// ============================================================
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_HTTP_LIMIT || '500', 10);
let globalDailyCount = 0;
let globalCountDate = null;

function resetGlobalCounter() {
  const today = new Date().toISOString().slice(0, 10);
  if (globalCountDate !== today) { globalDailyCount = 0; globalCountDate = today; }
}
function trackCall(n = 1) { resetGlobalCounter(); globalDailyCount += n; }
function globalBudgetRemaining() { resetGlobalCounter(); return Math.max(0, GLOBAL_DAILY_LIMIT - globalDailyCount); }

// ============================================================
// CIRCUIT BREAKER — per-provider AND per-ticker failure tracking
// Provider-level: After 5 consecutive failures, skip that provider for 10 min.
// Ticker-level:  After 3 consecutive failures on the SAME ticker across all
//   providers, skip that specific ticker for 30 min to avoid cascade.
// ============================================================
const circuitState = {};
const CB_THRESHOLD = 5;
const CB_COOLDOWN_MS = 10 * 60 * 1000;

// Per-ticker circuit breaker state
const tickerCircuitState = {};
const TICKER_CB_THRESHOLD = 3;
const TICKER_CB_COOLDOWN_MS = 30 * 60 * 1000;

function cbRecord(providerName, success, ticker) {
  if (!circuitState[providerName]) circuitState[providerName] = { failures: 0, openUntil: 0 };
  const s = circuitState[providerName];
  if (success) { s.failures = 0; }
  else {
    s.failures++;
    if (s.failures >= CB_THRESHOLD) {
      s.openUntil = Date.now() + CB_COOLDOWN_MS;
      console.warn(`[circuit-breaker] ${providerName} tripped — cooldown ${CB_COOLDOWN_MS / 1000}s`);
    }
  }
  // Per-ticker tracking
  if (ticker) {
    if (!tickerCircuitState[ticker]) tickerCircuitState[ticker] = { failures: 0, openUntil: 0 };
    const t = tickerCircuitState[ticker];
    if (success) { t.failures = 0; }
    else {
      t.failures++;
      if (t.failures >= TICKER_CB_THRESHOLD) {
        t.openUntil = Date.now() + TICKER_CB_COOLDOWN_MS;
        console.warn(`[circuit-breaker] ticker ${ticker} tripped — cooldown ${TICKER_CB_COOLDOWN_MS / 1000}s`);
      }
    }
  }
}
function cbIsOpen(providerName) {
  const s = circuitState[providerName];
  if (!s) return false;
  if (s.openUntil > Date.now()) return true;
  if (s.openUntil > 0 && Date.now() >= s.openUntil) { s.failures = 0; s.openUntil = 0; }
  return false;
}
function tickerCbIsOpen(ticker) {
  const t = tickerCircuitState[ticker];
  if (!t) return false;
  if (t.openUntil > Date.now()) return true;
  if (t.openUntil > 0 && Date.now() >= t.openUntil) { t.failures = 0; t.openUntil = 0; }
  return false;
}

// ============================================================
// EXPONENTIAL BACKOFF RETRY
// Retries a provider call up to maxRetries times on transient errors.
// Non-retryable codes (rate limits, no key) bypass immediately.
// ============================================================
const RETRY_NON_RETRYABLE = new Set([
  'GPW_NO_KEY', 'GPW_BUDGET_EXHAUSTED',
  'EODHD_NO_KEY', 'EODHD_BUDGET_EXHAUSTED', 'EODHD_UNSUPPORTED',
  'STOOQ_RATE_LIMIT', 'YAHOO_UNSUPPORTED',
]);

async function withRetry(fn, maxRetries = 2, baseDelayMs = 500) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (RETRY_NON_RETRYABLE.has(err.code)) throw err; // fast-fail
      if (attempt < maxRetries) {
        const jitter = Math.random() * baseDelayMs * 0.5; // 0-250ms jitter
        const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ============================================================
// BUDGET EXHAUSTION ALERTS
// Fires once per threshold crossing to avoid log spam.
// ============================================================
const budgetAlertState = { sentAt10Pct: false, sentAt0: false, lastResetDate: null, degraded: false };

function checkBudgetAlerts() {
  const today = new Date().toISOString().slice(0, 10);
  if (budgetAlertState.lastResetDate !== today) {
    budgetAlertState.sentAt10Pct = false;
    budgetAlertState.sentAt0 = false;
    budgetAlertState.degraded = false;
    budgetAlertState.lastResetDate = today;
  }
  const remaining = globalBudgetRemaining();
  const pct = remaining / GLOBAL_DAILY_LIMIT;
  if (!budgetAlertState.sentAt10Pct && pct <= 0.10) {
    console.warn(`[budget-alert] ⚠️  HTTP budget at 10%: ${remaining}/${GLOBAL_DAILY_LIMIT} remaining today`);
    budgetAlertState.sentAt10Pct = true;
  }
  if (!budgetAlertState.sentAt0 && remaining <= 0) {
    console.warn(`[budget-alert] 🔴 HTTP budget EXHAUSTED (${GLOBAL_DAILY_LIMIT} calls used) — all providers suspended until midnight`);
    budgetAlertState.sentAt0 = true;
    budgetAlertState.degraded = true;
  }
}

/**
 * Returns true if the system is in degraded mode (budget exhausted).
 */
function isDegraded() {
  return budgetAlertState.degraded;
}

/**
 * Get aggregated budget/health stats for all providers.
 */
function getBudgetStats() {
  resetGlobalCounter();
  return {
    globalDailyCount,
    globalDailyLimit: GLOBAL_DAILY_LIMIT,
    globalRemaining: globalBudgetRemaining(),
    gpw: gpwProvider.getRequestStats(),
    stooqJson: stooqJsonProvider.getRequestStats(),
    stooqCsv: stooqProvider.getRequestStats(),
    eodhd: eodhdProvider.getRequestStats(),
    circuitBreakers: Object.fromEntries(
      Object.entries(circuitState).map(([k, v]) => [k, { failures: v.failures, open: v.openUntil > Date.now() }])
    ),
    tickerCircuitBreakers: Object.fromEntries(
      Object.entries(tickerCircuitState)
        .filter(([, v]) => v.failures > 0 || v.openUntil > Date.now())
        .map(([k, v]) => [k, { failures: v.failures, open: v.openUntil > Date.now() }])
    ),
    degraded: budgetAlertState.degraded,
  };
}

// Asset classes that Yahoo cannot handle
const YAHOO_UNSUPPORTED_TICKERS = new Set([
  'WIG', 'WIG20', 'MWIG40', 'SWIG80',  // indices
  'FW20', 'FW40',                         // futures
]);

// Asset classes that EODHD cannot handle
const EODHD_UNSUPPORTED_TICKERS = new Set([
  'FW20', 'FW40',                         // futures
]);

// ---- EODHD mode: 'indices_only' (default) or 'all' ----
const EODHD_MODE = (process.env.EODHD_MODE || 'indices_only').toLowerCase();
const EODHD_INDICES = new Set(['WIG', 'WIG20', 'MWIG40', 'SWIG80']);

function isEodhdAllowed(ticker) {
  if (EODHD_UNSUPPORTED_TICKERS.has(ticker)) return false;
  if (EODHD_MODE === 'all') return true;
  return EODHD_INDICES.has(ticker);
}

/**
 * Fetch candles with automatic failover through provider chain.
 * Asset-class aware: skips EODHD for futures, skips Yahoo for indices/futures.
 */
async function fetchCandles(ticker, dateFrom, dateTo) {
  const errors = [];
  const isYahooCapable = !YAHOO_UNSUPPORTED_TICKERS.has(ticker);
  const isEodhdCapable = isEodhdAllowed(ticker);

  // Per-ticker circuit breaker check
  if (tickerCbIsOpen(ticker)) {
    return { provider: 'multi', candles: [], tickerCircuitOpen: true };
  }

  // Global budget check + alert
  checkBudgetAlerts();
  if (globalBudgetRemaining() <= 0) {
    console.warn(`[provider] Global daily limit reached (${GLOBAL_DAILY_LIMIT}) — skipping all providers`);
    return { provider: 'multi', candles: [], budgetExhausted: true };
  }

  // 1. GPW API (primary — all instruments, daily + intraday)
  if (!cbIsOpen('gpw') && gpwProvider.hasBudget()) {
    try {
      const candles = await withRetry(() => gpwProvider.fetchCandles(ticker, dateFrom, dateTo));
      trackCall();
      cbRecord('gpw', true, ticker);
      if (candles && candles.length > 0) {
        return { provider: 'gpw', candles };
      }
    } catch (err) {
      if (err.code !== 'GPW_NO_KEY' && err.code !== 'GPW_BUDGET_EXHAUSTED') {
        trackCall();
        cbRecord('gpw', false, ticker);
        errors.push(`gpw: ${err.message}`);
      }
    }
  }

  // 2. Stooq JSON (1 call, today's candle only — best for freshness)
  if (!cbIsOpen('stooq-json')) {
    try {
      const candles = await withRetry(() => stooqJsonProvider.fetchCandles(ticker, dateFrom, dateTo));
      trackCall();
      cbRecord('stooq-json', true, ticker);
      if (candles && candles.length > 0) {
        return { provider: 'stooq-json', candles };
      }
    } catch (err) {
      trackCall();
      cbRecord('stooq-json', false, ticker);
      errors.push(`stooq-json: ${err.message}`);
    }
  }

  // 3. Stooq CSV (historical range)
  if (!cbIsOpen('stooq-csv')) {
    try {
      const candles = await withRetry(() => stooqProvider.fetchCandles(ticker, dateFrom, dateTo));
      trackCall();
      cbRecord('stooq-csv', true, ticker);
      if (candles && candles.length > 0) {
        return { provider: 'stooq', candles };
      }
    } catch (err) {
      trackCall();
      cbRecord('stooq-csv', false, ticker);
      if (err && err.code === 'STOOQ_RATE_LIMIT') {
        errors.push(`stooq-csv: rate-limited until ${err.cooldownUntil}`);
      } else {
        errors.push(`stooq-csv: ${err.message}`);
      }
    }
  }

  // 4. EODHD (stocks, ETFs, indices — skip for futures)
  if (isEodhdCapable && !cbIsOpen('eodhd')) {
    try {
      const candles = await withRetry(() => eodhdProvider.fetchCandles(ticker, dateFrom, dateTo));
      trackCall();
      cbRecord('eodhd', true, ticker);
      if (candles && candles.length > 0) {
        return { provider: 'eodhd', candles };
      }
    } catch (err) {
      if (err.code !== 'EODHD_UNSUPPORTED' && err.code !== 'EODHD_NO_KEY' && err.code !== 'EODHD_BUDGET_EXHAUSTED') {
        trackCall();
        cbRecord('eodhd', false, ticker);
        errors.push(`eodhd: ${err.message}`);
      }
    }
  }

  // 5. Yahoo Finance (stocks/ETFs only — skip for indices/futures)
  if (isYahooCapable && !cbIsOpen('yahoo')) {
    try {
      const candles = await withRetry(() => yahooProvider.fetchCandles(ticker, dateFrom, dateTo));
      trackCall();
      cbRecord('yahoo', true, ticker);
      if (candles && candles.length > 0) {
        return { provider: 'yahoo', candles };
      }
    } catch (err) {
      trackCall();
      cbRecord('yahoo', false, ticker);
      if (err.code !== 'YAHOO_UNSUPPORTED') {
        errors.push(`yahoo: ${err.message}`);
      }
    }
  }

  // All failed
  if (errors.length > 0) {
    console.warn(`[provider] ${ticker}: all providers failed: ${errors.join(' | ')}`);
  }
  const rl = stooqProvider.getRateLimitState();
  if (rl.active) {
    return { provider: 'multi', candles: [], rateLimited: true, cooldownUntil: rl.cooldownUntil };
  }
  return { provider: 'multi', candles: [] };
}

/**
 * Batch fetch today's candles for ALL tickers using chunked HTTP calls.
 * Uses Stooq JSON batch endpoint — massive rate-limit savings.
 *
 * @param {string[]} tickers - internal GPW tickers
 * @param {number} [maxRequests=20] - HTTP call budget
 * @returns {Promise<{data: Map<string, object>, httpCalls: number, retryRecovered: number}>}
 */
async function fetchBatchQuotes(tickers, maxRequests = 20) {
  try {
    return await stooqJsonProvider.fetchBatch(tickers, maxRequests);
  } catch (err) {
    console.error(`[provider] Batch fetch failed: ${err.message}`);
    return { data: new Map(), httpCalls: 0, retryRecovered: 0 };
  }
}

/**
 * Health check all providers.
 */
async function healthCheckAll() {
  const results = await Promise.allSettled(providers.map((p) => p.healthCheck()));
  return results.map((r, i) => ({
    provider: providers[i].name,
    ...(r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message }),
  }));
}

module.exports = { fetchCandles, fetchBatchQuotes, healthCheckAll, getBudgetStats, isDegraded, _test: { cbRecord, cbIsOpen, tickerCbIsOpen, circuitState, tickerCircuitState, budgetAlertState, trackCall, globalBudgetRemaining, resetGlobalCounter } };

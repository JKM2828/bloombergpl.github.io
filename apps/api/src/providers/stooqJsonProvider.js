// ============================================================
// Stooq JSON Batch provider – chunked batch + retry-missing
//
// Uses the Stooq quote endpoint: /q/l/?s=TICKER1+TICKER2+...&e=json
// Returns intraday OHLCV snapshot (today's candle) for each ticker.
// Separate endpoint from CSV download → separate/no rate limit!
//
// Strategy:
//   1. Split tickers into chunks of CHUNK_SIZE (30)
//   2. Fetch each chunk sequentially (with jitter delay)
//   3. After first pass, retry still-missing tickers in mini-chunks of 5
//   4. Track HTTP call count for budget enforcement
//
// Coverage: stocks, ETFs, indices, futures – ALL GPW instruments.
// ============================================================
const https = require('https');
const { createCandle } = require('../../../../packages/shared/src');

const STOOQ_QUOTE_URL = 'https://stooq.pl/q/l/';

// ---- Tuning ----
const CHUNK_SIZE = 30;        // symbols per HTTP call (first pass)
const RETRY_CHUNK_SIZE = 10;  // symbols per retry HTTP call
const CHUNK_DELAY_MS = 800;   // delay between chunks
const JITTER_MAX_MS = 400;    // random jitter added to delay

// ---- Daily request counter ----
let dailyRequestCount = 0;
let cycleRequestCount = 0;    // requests in current fetchBatch() call
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
  return { dailyRequestCount, cycleRequestCount };
}

// ---- Health check cache ----
let cachedHealthResult = null;
let cachedHealthTime = 0;
const HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;

// ---- Comprehensive ticker mapping: GPW symbol → Stooq code ----
const STOOQ_TICKER_MAP = {
  // ETFs (need .pl suffix on Stooq)
  ETFBCASH:     'etfbcash.pl',
  ETFBDIVPL:    'etfbdivpl.pl',
  ETFBM40TR:    'etfbm40tr.pl',
  ETFBNDXPL:    'etfbndxpl.pl',
  ETFBNQ2ST:    'etfbnq2st.pl',
  ETFBNQ3LV:    'etfbnq3lv.pl',
  ETFBS80TR:    'etfbs80tr.pl',
  ETFBSPXPL:    'etfbspxpl.pl',
  ETFBTBSP:     'etfbtbsp.pl',
  ETFBTCPL:     'etfbtcpl.pl',
  ETFBW20LV:    'etfbw20lv.pl',
  ETFBW20ST:    'etfbw20st.pl',
  ETFBW20TR:    'etfbw20tr.pl',
  ETFDAX:       'etfdax.pl',
  ETFNATO:      'etfnato.pl',
  ETFPZUW20M40: 'etfpzuw20m40.pl',
  ETFSP500:     'etfsp500.pl',
  // Stocks (GPW official symbol → Stooq short code)
  '11BIT':      '11b',
  ABPL:         'ab',
  ACAUTOGAZ:    'acg',
  AGORA:        'ago',
  AILLERON:     'all',
  ALIOR:        'alr',
  ALLEGRO:      'ale',
  AMBRA:        'amb',
  AMICA:        'amc',
  AMREST:       'eat',
  APATOR:       'apt',
  ARCHICOM:     'arh',
  ARCTIC:       'atc',
  ARLEN:        'arl',
  ASBIS:        'abs',
  ASSECOBS:     'asb',
  ASSECOPOL:    'acp',
  ASSECOSEE:    'ase',
  ASTARTA:      'ast',
  ATAL:         '1at',
  AUTOPARTN:    'atp',
  BENEFIT:      'bft',
  BIOCELTIX:    'bcx',
  BIOTON:       'bio',
  BLOOBER:      'blo',
  BNPPPL:       'bnp',
  BOGDANKA:     'lwb',
  BORYSZEW:     'brs',
  BUDIMEX:      'bdx',
  BUMECH:       'bmc',
  CAPTORTX:     'cap',
  CDPROJEKT:    'cdr',
  CIGAMES:      'cig',
  CLNPHARMA:    'cln',
  COGNOR:       'cog',
  COLUMBUS:     'cle',
  COMP:         'cmp',
  CREEPYJAR:    'crj',
  CREOTECH:     'cri',
  CYBERFLKS:    'cfg',
  CYFRPLSAT:    'cps',
  DADELO:       'dad',
  DATAWALK:     'dat',
  DECORA:       'dcr',
  DEVELIA:      'dvl',
  DIAG:         'dia',
  DIGITANET:    'dgn',
  DINOPL:       'dnp',
  DOMDEV:       'dom',
  ECHO:         'ech',
  ELEKTROTI:    'elt',
  ENEA:         'ena',
  ENTER:        'ent',
  ERBUD:        'erb',
  EUROCASH:     'eur',
  FERRO:        'fro',
  FORTE:        'fte',
  GREENX:       'grx',
  GRUPAAZOTY:   'att',
  GRUPRACUJ:    'grc',
  HANDLOWY:     'bhw',
  HUUUGE:       'hug',
  INGBSK:       'ing',
  INTERCARS:    'car',
  KETY:         'kty',
  KGHM:         'kgh',
  KOGENERA:     'kgn',
  KRUK:         'kru',
  LUBAWA:       'lbw',
  MABION:       'mab',
  MBANK:        'mbk',
  MEDICALG:     'mdg',
  MENNICA:      'mnc',
  MERCATOR:     'mrc',
  MILLENNIUM:   'mil',
  MIRBUD:       'mrb',
  MLPGROUP:     'mlg',
  MLSYSTEM:     'mls',
  MOBRUK:       'mbr',
  MODIVO:       'mdv',
  MOSTALZAB:    'msz',
  MURAPOL:      'mur',
  NEUCA:        'neu',
  NEWAG:        'nwg',
  ONDE:         'ond',
  'OPONEO.PL':  'opn',
  ORANGEPL:     'opl',
  PCCROKITA:    'pcr',
  PEKABEX:      'pbx',
  PEKAO:        'peo',
  PEPCO:        'pco',
  PKNORLEN:     'pkn',
  PKOBP:        'pko',
  PLAYWAY:      'plw',
  POLIMEXMS:    'pxm',
  QUERCUS:      'qrs',
  RAINBOW:      'rbw',
  RYVU:         'rvu',
  SANOK:        'san',
  SANPL:        'spl',
  SCPFL:        'scp',
  SELENAFM:     'sel',
  SELVITA:      'slv',
  SHOPER:       'sho',
  SNIEZKA:      'snk',
  SNTVERSE:     'snt',
  STALEXP:      'ska',
  STALPROD:     'stp',
  SYGNITY:      'sgn',
  SYNEKTIK:     'sng',
  TARCZYNSKI:   'tar',
  TAURONPE:     'tpe',
  TEXT:         'txt',
  TORPOL:       'tor',
  TOYA:         'toa',
  TSGAMES:      'tsg',
  UNIBEP:       'uni',
  UNIMOT:       'unt',
  VERCOM:       'vrc',
  VIGOPHOTN:    'vgo',
  VOTUM:        'vot',
  VOXEL:        'vox',
  WAWEL:        'wwl',
  WIELTON:      'wlt',
  WIRTUALNA:    'wpl',
  WITTCHEN:     'wtn',
  XTPL:         'xtp',
  ZABKA:        'zab',
  ZEPAK:        'zep',
};

// Reverse map: Stooq symbol → internal ticker
const REVERSE_MAP = {};
for (const [internal, stooq] of Object.entries(STOOQ_TICKER_MAP)) {
  REVERSE_MAP[stooq.toUpperCase()] = internal;
}

function resolveStooqSymbol(ticker) {
  return STOOQ_TICKER_MAP[ticker] || ticker.toLowerCase();
}

function resolveInternalTicker(stooqSymbol) {
  const upper = stooqSymbol.toUpperCase();
  return REVERSE_MAP[upper] || upper;
}

/**
 * HTTPS GET returning raw text.
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'GPW-Bloomberg/1.0 (research)' },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Stooq JSON HTTP ${res.statusCode}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Stooq JSON timeout')); });
  });
}

/**
 * Fix Stooq's invalid JSON (trailing comma in "openint":})
 */
function fixStooqJson(raw) {
  return raw.replace(/openint":\s*}/g, 'openint":0}');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a SINGLE chunk of tickers (one HTTP call).
 * Returns Map<internalTicker, candle> for tickers with valid close.
 */
async function fetchChunk(tickers) {
  const stooqSymbols = tickers.map(resolveStooqSymbol);
  const url = `${STOOQ_QUOTE_URL}?s=${stooqSymbols.join('+')}&e=json`;

  resetDailyCounterIfNeeded();
  dailyRequestCount++;
  cycleRequestCount++;

  const raw = await httpsGet(url);

  // Check rate limit
  const normRaw = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (normRaw.includes('przekroczony dzienny limit wywolan')) {
    const err = new Error('Stooq JSON daily limit exceeded');
    err.code = 'STOOQ_RATE_LIMIT';
    throw err;
  }

  const fixed = fixStooqJson(raw);
  const json = JSON.parse(fixed);

  if (!json.symbols || !Array.isArray(json.symbols)) {
    return new Map();
  }

  const result = new Map();
  for (const s of json.symbols) {
    const internalTicker = resolveInternalTicker(s.symbol);
    const dateStr = String(s.date || '');
    if (dateStr.length < 8) continue;
    const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

    if (!s.close || s.close <= 0) continue;

    const candle = createCandle(
      date,
      s.open || s.close,
      s.high || s.close,
      s.low || s.close,
      s.close,
      s.volume || 0
    );
    result.set(internalTicker, candle);
  }

  return result;
}

/**
 * Fetch real-time OHLCV for MULTIPLE tickers using chunked HTTP calls.
 *
 * Pass 1: chunks of CHUNK_SIZE (30) — covers most tickers.
 * Pass 2: retry-missing in mini-chunks of RETRY_CHUNK_SIZE (10).
 *
 * @param {string[]} tickers - Array of internal GPW tickers
 * @param {number} [maxRequests=20] - HTTP call budget for this cycle
 * @returns {Promise<{data: Map<string, object>, httpCalls: number, retryRecovered: number}>}
 */
async function fetchBatch(tickers, maxRequests = 20) {
  if (!tickers || tickers.length === 0) {
    return { data: new Map(), httpCalls: 0, retryRecovered: 0 };
  }

  cycleRequestCount = 0;
  const result = new Map();
  let retryRecovered = 0;

  // ==== PASS 1: chunked fetch (30 per call) ====
  const chunks = [];
  for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
    chunks.push(tickers.slice(i, i + CHUNK_SIZE));
  }

  console.log(`[stooq-json] Pass 1: ${chunks.length} chunks of ≤${CHUNK_SIZE} (${tickers.length} tickers)`);

  for (let idx = 0; idx < chunks.length; idx++) {
    if (cycleRequestCount >= maxRequests) {
      console.warn(`[stooq-json] Budget limit (${maxRequests}) reached — stopping batch.`);
      break;
    }

    try {
      const chunkResult = await fetchChunk(chunks[idx]);
      for (const [t, c] of chunkResult) {
        result.set(t, c);
      }
      console.log(`[stooq-json]   chunk ${idx + 1}/${chunks.length}: ${chunkResult.size}/${chunks[idx].length} ok`);
    } catch (err) {
      if (err.code === 'STOOQ_RATE_LIMIT') {
        console.warn(`[stooq-json] Rate limit hit at chunk ${idx + 1}/${chunks.length} — returning ${result.size} partial results`);
        return { data: result, httpCalls: cycleRequestCount, retryRecovered: 0, rateLimited: true };
      }
      console.warn(`[stooq-json]   chunk ${idx + 1} error: ${err.message}`);
    }

    // Delay between chunks (skip after last)
    if (idx < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS + Math.floor(Math.random() * JITTER_MAX_MS));
    }
  }

  // ==== PASS 2: retry missing in mini-chunks ====
  const missing = tickers.filter(t => !result.has(t));
  if (missing.length > 0 && cycleRequestCount < maxRequests) {
    const retryChunks = [];
    for (let i = 0; i < missing.length; i += RETRY_CHUNK_SIZE) {
      retryChunks.push(missing.slice(i, i + RETRY_CHUNK_SIZE));
    }

    const retryBudget = maxRequests - cycleRequestCount;
    const retryLimit = Math.min(retryChunks.length, retryBudget);
    console.log(`[stooq-json] Pass 2: retry ${missing.length} missing in ${retryLimit} chunk(s) of ≤${RETRY_CHUNK_SIZE}`);

    for (let idx = 0; idx < retryLimit; idx++) {
      if (cycleRequestCount >= maxRequests) break;

      await sleep(CHUNK_DELAY_MS + Math.floor(Math.random() * JITTER_MAX_MS));

      try {
        const retryResult = await fetchChunk(retryChunks[idx]);
        for (const [t, c] of retryResult) {
          if (!result.has(t)) {
            result.set(t, c);
            retryRecovered++;
          }
        }
        console.log(`[stooq-json]   retry ${idx + 1}/${retryLimit}: ${retryResult.size}/${retryChunks[idx].length} recovered`);
      } catch (err) {
        if (err.code === 'STOOQ_RATE_LIMIT') {
          console.warn(`[stooq-json] Rate limit hit at retry ${idx + 1}/${retryLimit} — returning ${result.size} partial results`);
          return { data: result, httpCalls: cycleRequestCount, retryRecovered };
        }
        console.warn(`[stooq-json]   retry ${idx + 1} error: ${err.message}`);
      }
    }
  }

  const httpCalls = cycleRequestCount;
  console.log(`[stooq-json] Done: ${result.size}/${tickers.length} tickers, ${httpCalls} HTTP calls, ${retryRecovered} retry-recovered`);

  return { data: result, httpCalls, retryRecovered };
}

/**
 * Fetch candles for a SINGLE ticker (compatibility with provider interface).
 * Returns array with single today's candle.
 */
async function fetchCandles(ticker, dateFrom, dateTo) {
  const { data } = await fetchBatch([ticker], 1);
  const candle = data.get(ticker);
  return candle ? [candle] : [];
}

/**
 * Health check – fetch WIG quote.
 */
async function healthCheck() {
  if (cachedHealthResult && (Date.now() - cachedHealthTime) < HEALTH_CACHE_TTL_MS) {
    return { ...cachedHealthResult, cached: true, ...getRequestStats() };
  }

  try {
    const { data } = await fetchBatch(['WIG', 'PKN'], 1);
    const ok = data.size >= 1;
    const result = { ok, provider: 'stooq-json', tickers: data.size };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  } catch (err) {
    const result = { ok: false, provider: 'stooq-json', error: err.message };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  }
}

module.exports = {
  name: 'stooq-json',
  fetchCandles,
  fetchBatch,
  healthCheck,
  getRequestStats,
  resolveStooqSymbol,
  resolveInternalTicker,
};

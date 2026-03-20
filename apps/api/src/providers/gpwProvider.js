// ============================================================
// GPW Scraper Provider – Primary live data source
//
// Uses Stooq public endpoints (no API key required):
//   - Live quotes: stooq.pl/q/l/?s=SYM1+SYM2&e=json
//   - Historical CSV: stooq.pl/q/d/l/?s=SYM&d1=...&d2=...&i=d
//   - Intraday CSV: stooq.pl/q/d/l/?s=SYM&d1=...&d2=...&i=5
//
// Coverage: stocks, ETFs, indices, futures – ALL GPW instruments.
// ============================================================
const https = require('https');
const { createCandle } = require('../../../../packages/shared/src');

const STOOQ_QUOTE_URL = 'https://stooq.pl/q/l/';
const STOOQ_CSV_BASE  = 'https://stooq.pl/q/d/l/';

// ---- Tuning ----
const CHUNK_SIZE     = 30;
const CHUNK_DELAY_MS = 1000;
const JITTER_MAX_MS  = 500;

// ---- Request counter ----
let dailyRequestCount = 0;
let requestCountDate  = null;

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (requestCountDate !== today) {
    dailyRequestCount = 0;
    requestCountDate = today;
  }
}

function hasBudget() { return true; }

function getRequestStats() {
  resetDailyCounterIfNeeded();
  return {
    source: 'stooq-live-scraper',
    noKeyRequired: true,
    dailyRequestCount,
  };
}

// ---- Health check cache ----
let cachedHealthResult = null;
let cachedHealthTime   = 0;
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

// Reverse map: Stooq symbol → internal GPW ticker
const REVERSE_MAP = {};
for (const [internal, stooq] of Object.entries(STOOQ_TICKER_MAP)) {
  REVERSE_MAP[stooq.toUpperCase()] = internal;
}

function resolveStooqSymbol(ticker) {
  return STOOQ_TICKER_MAP[ticker] || ticker.toLowerCase();
}

function resolveInternalTicker(stooqSymbol) {
  const upper = stooqSymbol.toUpperCase();
  if (upper.endsWith('.PL')) {
    return REVERSE_MAP[upper] || upper.replace('.PL', '');
  }
  return REVERSE_MAP[upper] || upper;
}

// ---- HTTP helper ----
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'GPW-Bloomberg/2.0 (research)' },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const err = new Error('Stooq rate limit');
          err.code = 'GPW_RATE_LIMIT';
          return reject(err);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Stooq HTTP ${res.statusCode}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Stooq timeout')); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// fetchBatchQuotes – Live snapshot for multiple tickers
// ============================================================
async function fetchBatchQuotes(tickers) {
  const result = new Map();
  const chunks = [];
  for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
    chunks.push(tickers.slice(i, i + CHUNK_SIZE));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    if (ci > 0) await sleep(CHUNK_DELAY_MS + Math.random() * JITTER_MAX_MS);
    const chunk = chunks[ci];
    const stooqSymbols = chunk.map(resolveStooqSymbol);
    const url = `${STOOQ_QUOTE_URL}?s=${stooqSymbols.join('+')}&e=json`;

    resetDailyCounterIfNeeded();
    dailyRequestCount++;

    try {
      const raw = await httpsGet(url);
      const json = JSON.parse(raw);
      if (!json || !Array.isArray(json.symbols)) continue;

      for (const sym of json.symbols) {
        if (!sym.close || sym.close <= 0) continue;
        const dateStr = String(sym.date);
        const timeStr = sym.time ? String(sym.time).padStart(6, '0') : '';
        const d = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
        const t = timeStr ? ` ${timeStr.slice(0,2)}:${timeStr.slice(2,4)}` : '';
        const internalTicker = resolveInternalTicker(sym.symbol);
        result.set(internalTicker, createCandle(
          d + t,
          sym.open || sym.close,
          sym.high || sym.close,
          sym.low  || sym.close,
          sym.close,
          sym.volume || 0,
        ));
      }
    } catch {
      // skip failed chunk
    }
  }
  return result;
}

// ============================================================
// fetchQuote – Single ticker snapshot
// ============================================================
async function fetchQuote(ticker) {
  const map = await fetchBatchQuotes([ticker]);
  return map.get(ticker) || null;
}

// ============================================================
// fetchCandles – Historical daily candles via CSV
// ============================================================
async function fetchCandles(ticker, dateFrom, dateTo) {
  const sym = resolveStooqSymbol(ticker);
  const url = `${STOOQ_CSV_BASE}?s=${sym}&d1=${dateFrom}&d2=${dateTo}&i=d`;

  resetDailyCounterIfNeeded();
  dailyRequestCount++;

  const raw = await httpsGet(url);
  return parseCsvCandles(raw);
}

function parseCsvCandles(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  const hasTime = header.includes('time');
  const candles = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    let idx = 0;
    const date = cols[idx++];
    if (hasTime) idx++; // skip time column
    const open  = parseFloat(cols[idx++]);
    const high  = parseFloat(cols[idx++]);
    const low   = parseFloat(cols[idx++]);
    const close = parseFloat(cols[idx++]);
    const vol   = parseInt(cols[idx] || '0', 10);
    if (!close || close <= 0) continue;
    candles.push(createCandle(date, open || close, high || close, low || close, close, vol || 0));
  }
  return candles;
}

// ============================================================
// fetchIntraday – Tries 5m → 15m → 60m via CSV
// ============================================================
async function fetchIntraday(ticker, dateFrom, dateTo) {
  const sym = resolveStooqSymbol(ticker);
  const intervals = [5, 15, 60];

  for (const interval of intervals) {
    const url = `${STOOQ_CSV_BASE}?s=${sym}&d1=${dateFrom}&d2=${dateTo}&i=${interval}`;
    resetDailyCounterIfNeeded();
    dailyRequestCount++;

    try {
      const raw = await httpsGet(url);
      if (raw.includes('Brak danych')) continue;
      const candles = parseCsvCandles(raw);
      if (candles.length > 0) return candles;
    } catch {
      continue;
    }
  }
  return [];
}

// ============================================================
// Health check
// ============================================================
async function healthCheck() {
  if (cachedHealthResult && (Date.now() - cachedHealthTime) < HEALTH_CACHE_TTL_MS) {
    return cachedHealthResult;
  }

  try {
    const map = await fetchBatchQuotes(['PKNORLEN', 'PKOBP']);
    cachedHealthResult = {
      ok: map.size > 0,
      provider: 'gpw',
      tickers: map.size,
      ...getRequestStats(),
    };
  } catch (err) {
    cachedHealthResult = {
      ok: false,
      provider: 'gpw',
      error: err.message,
      ...getRequestStats(),
    };
  }
  cachedHealthTime = Date.now();
  return cachedHealthResult;
}

module.exports = {
  name: 'gpw',
  fetchCandles,
  fetchIntraday,
  fetchQuote,
  fetchBatchQuotes,
  healthCheck,
  getRequestStats,
  hasBudget,
};

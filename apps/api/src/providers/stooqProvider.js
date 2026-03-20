// ============================================================
// Stooq data provider – fetches CSV historical data
// ============================================================
const axios = require('axios');
const { createCandle } = require('../../../../packages/shared/src');

const STOOQ_BASE = 'https://stooq.pl/q/d/l/';

// ---- Rate-limit cooldown state (auto-resets at midnight) ----
let rateLimitCooldownUntil = null;

// ---- Daily request counter (self-imposed soft limit) ----
const SOFT_DAILY_LIMIT = 180;     // self-imposed; Stooq hard limit ~250-300
let dailyRequestCount = 0;
let requestCountDate = null;      // YYYY-MM-DD

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (requestCountDate !== today) {
    dailyRequestCount = 0;
    requestCountDate = today;
  }
}

function getRequestStats() {
  resetDailyCounterIfNeeded();
  return { dailyRequestCount, softLimit: SOFT_DAILY_LIMIT, remaining: Math.max(0, SOFT_DAILY_LIMIT - dailyRequestCount) };
}

// ---- Health check cache (avoid hitting Stooq every 15 min) ----
let cachedHealthResult = null;
let cachedHealthTime = 0;
const HEALTH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getNextLocalMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
}

function isRateLimitText(text) {
  const norm = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return norm.includes('przekroczony dzienny limit wywolan');
}

function getRateLimitState() {
  if (!rateLimitCooldownUntil) return { active: false, cooldownUntil: null, msRemaining: 0 };
  const ms = rateLimitCooldownUntil.getTime() - Date.now();
  if (ms <= 0) { rateLimitCooldownUntil = null; return { active: false, cooldownUntil: null, msRemaining: 0 }; }
  return { active: true, cooldownUntil: rateLimitCooldownUntil.toISOString(), msRemaining: ms };
}

function makeRateLimitError(cooldownUntil) {
  const err = new Error(`Stooq daily limit exceeded – cooldown until ${cooldownUntil}`);
  err.code = 'STOOQ_RATE_LIMIT';
  err.cooldownUntil = cooldownUntil;
  return err;
}

// Comprehensive mapping: GPW official symbol → Stooq short code.
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
  BOS:           'bos',
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

/**
 * Resolve internal ticker to Stooq-compatible symbol.
 */
function resolveStooqSymbol(ticker) {
  return STOOQ_TICKER_MAP[ticker] || ticker.toLowerCase();
}

/**
 * Fetch OHLCV candles from Stooq for a given ticker.
 * @param {string} ticker – Internal GPW ticker (e.g. 'PKN', 'ETFW20L')
 * @param {string} dateFrom – 'YYYYMMDD'
 * @param {string} dateTo   – 'YYYYMMDD'
 * @returns {Promise<Array>} array of candle objects
 */
async function fetchCandles(ticker, dateFrom, dateTo) {
  // Check cooldown – skip HTTP if rate-limited (auto-resets after midnight)
  const rl = getRateLimitState();
  if (rl.active) throw makeRateLimitError(rl.cooldownUntil);

  // Self-imposed soft limit – stop before hitting Stooq's hard limit
  resetDailyCounterIfNeeded();
  if (dailyRequestCount >= SOFT_DAILY_LIMIT) {
    rateLimitCooldownUntil = getNextLocalMidnight();
    console.warn(`[stooq] Soft daily limit (${SOFT_DAILY_LIMIT}) reached – self-imposed cooldown until ${rateLimitCooldownUntil.toISOString()}`);
    throw makeRateLimitError(rateLimitCooldownUntil.toISOString());
  }

  const stooqSymbol = resolveStooqSymbol(ticker);
  const url = `${STOOQ_BASE}?s=${stooqSymbol}&d1=${dateFrom}&d2=${dateTo}&i=d`;

  dailyRequestCount++;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'GPW-Bloomberg/1.0 (research)' },
    responseType: 'text',
  });

  // Detect rate-limit response → set cooldown until next midnight
  if (isRateLimitText(response.data)) {
    rateLimitCooldownUntil = getNextLocalMidnight();
    console.warn(`[stooq] Daily limit hit – cooldown until ${rateLimitCooldownUntil.toISOString()}`);
    throw makeRateLimitError(rateLimitCooldownUntil.toISOString());
  }

  return parseCsv(response.data, ticker);
}

/**
 * Parse Stooq CSV into candle objects.
 * Stooq CSV format: Date,Open,High,Low,Close,Volume
 */
function parseCsv(csv, ticker) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  const hasVolume = header.includes('volume') || header.includes('wolumen');

  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;

    const [dateStr, openStr, highStr, lowStr, closeStr, volStr] = parts;
    const open = parseFloat(openStr);
    const high = parseFloat(highStr);
    const low = parseFloat(lowStr);
    const close = parseFloat(closeStr);
    const volume = hasVolume && volStr ? parseInt(volStr, 10) : 0;

    if (isNaN(close)) continue;

    // Normalize date to YYYY-MM-DD
    const date = normalizeDate(dateStr);
    if (!date) continue;

    candles.push(createCandle(date, open, high, low, close, volume));
  }

  return candles;
}

function normalizeDate(d) {
  // Stooq sends dates as YYYY-MM-DD or YYYYMMDD
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return null;
}

/**
 * Health check – try fetching WIG index for today.
 * Cached for 15 min to avoid wasting requests.
 */
async function healthCheck() {
  // If rate-limited, report without hitting Stooq
  const rl = getRateLimitState();
  if (rl.active) {
    return { ok: false, provider: 'stooq', rateLimited: true, cooldownUntil: rl.cooldownUntil, error: 'Daily limit – cooldown active', ...getRequestStats() };
  }

  // Return cached health result if fresh enough
  if (cachedHealthResult && (Date.now() - cachedHealthTime) < HEALTH_CACHE_TTL_MS) {
    return { ...cachedHealthResult, cached: true, ...getRequestStats() };
  }

  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const candles = await fetchCandles('WIG', from, today);
    const result = { ok: candles.length > 0, provider: 'stooq', candles: candles.length };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  } catch (err) {
    const isRL = err.code === 'STOOQ_RATE_LIMIT';
    const result = { ok: false, provider: 'stooq', ...(isRL ? { rateLimited: true, cooldownUntil: err.cooldownUntil } : {}), error: err.message };
    cachedHealthResult = result;
    cachedHealthTime = Date.now();
    return { ...result, ...getRequestStats() };
  }
}

module.exports = {
  name: 'stooq',
  getRequestStats,
  fetchCandles,
  parseCsv,
  getRateLimitState,
  healthCheck,
};

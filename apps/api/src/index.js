// ============================================================
// GPW Bloomberg – API Server entry point (v2 with ML + Worker + Live)
// ============================================================
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { initDb, startAutoSave } = require('./db/connection');
const { migrate } = require('./db/migrate');
const { seed } = require('./db/seed');
const routes = require('./routes');
const { startScheduler } = require('./worker/jobWorker');
const { loadModelsFromDb } = require('./ml/mlEngine');
const { loadT1Model } = require('./ml/topGainersT1');
const { attachWebSocket } = require('./ws/liveCandles');

const PORT = process.env.PORT || 3001;
const app = express();

// ---- Middleware ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // needed for inline scripts in frontend
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS — restrict to known origins (fallback: allow all in dev)
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : null; // null = allow all (dev mode)
if (!ALLOWED_ORIGINS && process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY] CORS_ORIGINS not set in production — all origins allowed. Set CORS_ORIGINS env var.');
}
app.use(cors({
  origin: ALLOWED_ORIGINS || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
}));
app.use(express.json());

// Rate limiting — 120 req/min per IP (generous for dashboard polling)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', apiLimiter);

// Stricter rate-limit for costly / admin POST endpoints (3 req / 10 min)
const costlyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded for costly operation. Try again in a few minutes.' },
});
const costlyPaths = [
  '/api/pipeline/run', '/api/pipeline/recover', '/api/ml/train', '/api/ml/backtest', '/api/ml/features',
  '/api/ingest/full', '/api/ingest/incremental', '/api/ingest/intraday', '/api/ingest/intraday5m', '/api/ingest/backfill',
  '/api/predictions/run', '/api/ranking/run', '/api/worker/drain', '/api/worker/enqueue',
  '/api/portfolio/deposit', '/api/portfolio/withdraw', '/api/portfolio/buy', '/api/portfolio/sell',
];
costlyPaths.forEach(p => app.use(p, costlyLimiter));

// X-Request-ID — trace every request
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Request logging with request-id
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms [${req.id}]`);
  });
  next();
});

// ---- Disclaimer middleware – adds header ----
app.use((req, res, next) => {
  res.setHeader('X-Disclaimer',
    'Dane informacyjne. Nie stanowia porady inwestycyjnej. Inwestowanie wiaze sie z ryzykiem.');
  next();
});

// ---- Keepalive endpoint (for UptimeRobot / cron-job.org) ----
app.get('/keepalive', (req, res) => {
  res.status(200).json({ status: 'alive', uptime: process.uptime() | 0 });
});

// ---- Routes ----
app.use('/api', routes);

// ---- Serve frontend (static files from apps/web/public) ----
const webPublicDir = path.join(__dirname, '..', '..', 'web', 'public');
app.use(express.static(webPublicDir));
// SPA fallback: return index.html for non-API routes
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(webPublicDir, 'index.html'));
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'GPW Bloomberg API',
    version: '2.0.0',
    disclaimer: 'Dane wyłącznie informacyjne. Nie stanowią porady inwestycyjnej.',
    endpoints: {
      instruments: '/api/instruments',
      candles: '/api/candles/:ticker',
      ranking: '/api/ranking',
      predictions: '/api/predictions',
      signals: '/api/signals',
      ml: '/api/ml/*',
      risk: '/api/risk/*',
      portfolio: '/api/portfolio/*',
      worker: '/api/worker/status',
      pipeline: '/api/pipeline/run',
      audit: '/api/audit',
      health: '/api/health',
      ingest: '/api/ingest/*',
    },
  });
});

// ---- Global error handlers ----
process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught Exception:', err);
  // Give time for logs to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

// ---- Init DB & start ----
let _server = null;

(async () => {
  await migrate();
  await seed();
  startAutoSave();

  _server = http.createServer(app);

  // Attach WebSocket live feed (ws://localhost:PORT/ws/live?ticker=PKN&tf=5m)
  attachWebSocket(_server);

  _server.listen(PORT, () => {
    console.log(`\n🚀 GPW Bloomberg API v2.0 running on http://localhost:${PORT}`);
    console.log('   ML + Risk + Worker engine active');
    console.log('   WebSocket live feed: ws://localhost:' + PORT + '/ws/live?ticker=TICKER&tf=5m');
    console.log('   Endpoints: /api/predictions, /api/signals, /api/risk/*, /api/worker/*');
    console.log('   Health: /api/health\n');
  });

  // Load previously trained ML models from DB
  loadModelsFromDb();
  loadT1Model();

  // Start the 24/7 background worker scheduler
  startScheduler();

  // ---- Auto-bootstrap: trigger initial ingest + analysis on fresh start ----
  const { enqueueJob, drainQueue } = require('./worker/jobWorker');
  const { queryOne: qo } = require('./db/connection');
  const lastIngest = (qo("SELECT MAX(created_at) as d FROM ingest_log WHERE status = 'ok'") || {}).d;
  const hoursSinceIngest = lastIngest ? (Date.now() - new Date(lastIngest).getTime()) / 3600000 : 9999;
  if (hoursSinceIngest > 1) {
    console.log(`[bootstrap] Last ingest ${lastIngest ? Math.round(hoursSinceIngest) + 'h ago' : 'never'} — auto-starting pipeline...`);
    enqueueJob('full_pipeline', {}, 1);
    drainQueue().catch(err => console.error('[bootstrap] Pipeline error:', err.message));
  } else {
    console.log(`[bootstrap] Data fresh (${Math.round(hoursSinceIngest * 60)}min old) — skipping auto-ingest.`);
  }
})();

// ---- Graceful shutdown ----
function gracefulShutdown(signal) {
  console.log(`[process] ${signal} received — shutting down gracefully...`);
  const { stopScheduler } = require('./worker/jobWorker');
  const { closeDb } = require('./db/connection');
  const { stopPolling } = require('./ws/liveCandles');

  stopScheduler();
  stopPolling();

  if (_server) {
    _server.close(() => {
      console.log('[process] HTTP server closed');
      try { closeDb(); } catch (e) { console.error('[process] DB close error:', e.message); }
      process.exit(0);
    });
    // Force exit after 10s if connections won't close
    setTimeout(() => {
      console.error('[process] Forced exit after 10s timeout');
      process.exit(1);
    }, 10000);
  } else {
    try { closeDb(); } catch (e) { console.error('[process] DB close error:', e.message); }
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;

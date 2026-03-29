// ============================================================
// Database migrations
// ============================================================
const { getDb, initDb, saveDb } = require('./connection');

async function migrate() {
  await initDb();
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS instruments (
      ticker TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      isin TEXT,
      sector TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add sector column if missing (migration for existing DBs)
  try { db.run('ALTER TABLE instruments ADD COLUMN sector TEXT'); } catch(e) { /* already exists */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS candles (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER DEFAULT 0,
      provider TEXT DEFAULT 'stooq',
      timeframe TEXT DEFAULT '1d',
      PRIMARY KEY (ticker, date, provider)
    )
  `);

  // Migration: add timeframe column if missing (existing DBs)
  try { db.run("ALTER TABLE candles ADD COLUMN timeframe TEXT DEFAULT '1d'"); } catch(e) { /* already exists */ }

  db.run(`CREATE INDEX IF NOT EXISTS idx_candles_ticker_date ON candles(ticker, date DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_candles_tf ON candles(ticker, timeframe, date DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS rankings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      score REAL NOT NULL,
      metrics TEXT,
      reason TEXT,
      ranked_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_rankings_date ON rankings(ranked_at DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      ticker TEXT NOT NULL,
      status TEXT NOT NULL,
      rows_inserted INTEGER DEFAULT 0,
      message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS portfolio_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT DEFAULT 'default',
      type TEXT NOT NULL,
      ticker TEXT,
      shares REAL,
      price REAL,
      amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS data_quality (
      ticker TEXT NOT NULL,
      provider TEXT NOT NULL,
      completeness REAL,
      freshness TEXT,
      notes TEXT,
      checked_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ticker, provider)
    )
  `);

  // ---- ML & Feature Store tables ----
  db.run(`
    CREATE TABLE IF NOT EXISTS features (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      sma20 REAL, sma50 REAL, sma200 REAL,
      ema12 REAL, ema26 REAL,
      rsi14 REAL, rsi7 REAL,
      macd REAL, macd_signal REAL, macd_hist REAL,
      bb_upper REAL, bb_middle REAL, bb_lower REAL,
      atr14 REAL,
      obv REAL,
      vol_20d REAL,
      momentum_1m REAL, momentum_3m REAL, momentum_6m REAL,
      volume_ratio REAL,
      max_dd_60d REAL,
      regime TEXT,
      pivot_r2 REAL, pivot_r1 REAL, pivot_pp REAL, pivot_s1 REAL, pivot_s2 REAL,
      vwap_proxy REAL,
      momentum_5d REAL, momentum_10d REAL,
      relative_strength REAL,
      computed_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ticker, date)
    )
  `);

  // Migrations for existing DBs – add new feature columns
  const newFeatureCols = [
    "pivot_r2 REAL", "pivot_r1 REAL", "pivot_pp REAL", "pivot_s1 REAL", "pivot_s2 REAL",
    "vwap_proxy REAL", "momentum_5d REAL", "momentum_10d REAL", "relative_strength REAL",
    "sector_rs REAL",
  ];
  for (const col of newFeatureCols) {
    try { db.run(`ALTER TABLE features ADD COLUMN ${col}`); } catch(e) { /* exists */ }
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_features_ticker_date ON features(ticker, date DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      model_version TEXT NOT NULL,
      prediction_date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      predicted_return REAL,
      confidence REAL,
      predicted_direction TEXT,
      scenario_bull REAL,
      scenario_base REAL,
      scenario_bear REAL,
      features_used TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_pred_ticker_date ON predictions(ticker, prediction_date DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      direction TEXT NOT NULL,
      confidence REAL,
      expected_return REAL,
      risk_score REAL,
      position_size REAL,
      stop_loss REAL,
      take_profit REAL,
      hold_days INTEGER,
      model_version TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker, created_at DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS model_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name TEXT NOT NULL,
      version TEXT NOT NULL,
      accuracy REAL,
      sharpe_ratio REAL,
      max_drawdown REAL,
      training_samples INTEGER,
      config TEXT,
      weights TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity TEXT,
      entity_id TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type, created_at DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      payload TEXT,
      priority INTEGER DEFAULT 5,
      retries INTEGER DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority, created_at)`);

  // ---- Daily Picks (Top 5 aggressive swing) + ex-post validation ----
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      pick_date TEXT NOT NULL,
      rank INTEGER NOT NULL,
      composite_score REAL,
      components TEXT,
      entry_price REAL,
      stop_loss REAL,
      take_profit REAL,
      regime TEXT,
      reasons TEXT,
      return_1d REAL,
      return_2d REAL,
      return_3d REAL,
      mae REAL,
      mfe REAL,
      validated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(ticker, pick_date)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_daily_picks_date ON daily_picks(pick_date DESC)`);

  // Backtest results
  db.run(`
    CREATE TABLE IF NOT EXISTS backtest_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT,
      total_tickers INTEGER,
      passed_tickers INTEGER,
      avg_hit_rate REAL,
      avg_profit_factor REAL,
      avg_expectancy REAL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ---- Pipeline Runs – per-batch tracking with per-ticker status ----
  db.run(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT DEFAULT 'running',
      universe_total INTEGER DEFAULT 0,
      ingested_ok INTEGER DEFAULT 0,
      features_ok INTEGER DEFAULT 0,
      predicted_ok INTEGER DEFAULT 0,
      ranked_ok INTEGER DEFAULT 0,
      coverage_pct REAL DEFAULT 0,
      degraded INTEGER DEFAULT 0,
      error TEXT,
      summary TEXT
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_id ON pipeline_runs(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status, started_at DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS pipeline_ticker_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(run_id, ticker, stage)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_pts_run ON pipeline_ticker_status(run_id, stage)`);

  // ---- Competition Portfolio – tracks real competition positions ----
  db.run(`
    CREATE TABLE IF NOT EXISTS competition_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      shares REAL NOT NULL,
      entry_price REAL NOT NULL,
      entry_date TEXT NOT NULL,
      exit_price REAL,
      exit_date TEXT,
      status TEXT DEFAULT 'open',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_comp_port_status ON competition_portfolio(status)`);

  saveDb();
  console.log('[migrate] Database schema created / verified.');
}

if (require.main === module) {
  migrate().then(() => process.exit(0));
}

module.exports = { migrate };

// ============================================================
// Job Worker – 24/7 background processing for GPW Bloomberg
//
// Session-aware scheduler:
//   MARKET HOURS  (Mon-Fri 9-17 Warsaw): ingest every 15 min,
//     continuous analysis (features → predict → signals → screener)
//     after each successful ingest.
//   OFF-HOURS (17-23 weekday + weekends): eco mode, ingest every
//     60 min, analysis every 2h, preserving API budget.
//   NIGHT (23-9): no ingest (no new data), only queue drain.
//
// Anti-overlap: only one job of each type runs at a time.
// Crash recovery: stuck 'running' jobs reset to pending on start.
// Continuous analysis: chained automatically after ingest success.
// ============================================================
const cron = require('node-cron');
const { query, queryOne, run, saveDb } = require('../db/connection');
const { ingestIncremental, ingestAll, ingestIntraday5m, getLastCycleStats } = require('../ingest/ingestPipeline');
const { computeAllFeatures } = require('../ml/featureEngineering');
const { trainAll, predictAll } = require('../ml/mlEngine');
const { generateAllSignals } = require('../ml/riskEngine');
const { runScreener, getDailyPicks, saveDailyPicks, validatePastPicks, getPickStats } = require('../screener/rankingService');

const TIMEZONE = 'Europe/Warsaw';

// ============================================================
// JOB TIMEOUTS — auto-recover stuck jobs
// ============================================================
const JOB_TIMEOUTS = {
  full_pipeline: 10 * 60 * 1000,  // 10 min
  ingest:        5 * 60 * 1000,   // 5 min
  analysis:      8 * 60 * 1000,   // 8 min
  train:         15 * 60 * 1000,  // 15 min
  screener:      2 * 60 * 1000,   // 2 min
  features:      3 * 60 * 1000,   // 3 min
  predict:       3 * 60 * 1000,   // 3 min
  intraday5m:    3 * 60 * 1000,   // 3 min
};
const DEFAULT_JOB_TIMEOUT = 5 * 60 * 1000;

function getJobTimeout(jobType) {
  return JOB_TIMEOUTS[jobType] || DEFAULT_JOB_TIMEOUT;
}

// ============================================================
// PRECISION KPI — tracks model quality over time
// Auto-retrains when precision@1D drops below threshold.
// ============================================================
const PRECISION_RETRAIN_THRESHOLD = 45; // % — below this triggers emergency retrain
const PRECISION_WARN_THRESHOLD = 55;    // % — warn but keep running
let lastPrecisionCheck = null;

/**
 * Check current pick precision and log alerts.
 * Returns { precision1D, status: 'ok'|'warn'|'critical', retrain: boolean }
 */
function checkPrecisionKPI() {
  const stats = getPickStats(30);
  if (!stats || stats.totalPicks < 5) {
    return { precision1D: null, precision3D: null, totalPicks: stats?.totalPicks || 0, status: 'no_data', retrain: false };
  }
  const { precision1D, precision3D, totalPicks } = stats;
  lastPrecisionCheck = { precision1D, precision3D, totalPicks, checkedAt: new Date().toISOString() };

  let status = 'ok';
  let retrain = false;
  if (precision1D < PRECISION_RETRAIN_THRESHOLD) {
    console.warn(`[precision-kpi] 🔴 CRITICAL: precision@1D=${precision1D}% (threshold: ${PRECISION_RETRAIN_THRESHOLD}%) — triggering emergency retrain`);
    status = 'critical';
    retrain = true;
  } else if (precision1D < PRECISION_WARN_THRESHOLD) {
    console.warn(`[precision-kpi] ⚠️  WARN: precision@1D=${precision1D}% (threshold: ${PRECISION_WARN_THRESHOLD}%) — model degrading`);
    status = 'warn';
  } else {
    console.log(`[precision-kpi] ✅ OK: precision@1D=${precision1D}%, precision@3D=${precision3D}% (${totalPicks} picks)`);
  }
  return { precision1D, precision3D, totalPicks, status, retrain };
}

function getPrecisionKPI() {
  return lastPrecisionCheck;
}

let isRunning = false;
// Anti-overlap locks per job type
const runningLocks = new Set();

let stats = {
  lastIngest: null,
  lastFeatures: null,
  lastTraining: null,
  lastPrediction: null,
  lastScreener: null,
  lastAnalysisCycle: null,
  jobsProcessed: 0,
  jobsFailed: 0,
  startedAt: null,
  analysisRuns: 0,
  mode: 'starting', // 'market', 'off-hours', 'night'
  lastRunId: null,
};

// ============================================================
// PIPELINE RUN TRACKING
// ============================================================

function generateRunId() {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `run_${ts}_${rand}`;
}

function createPipelineRun(runId, universeTotal) {
  run(`INSERT INTO pipeline_runs (run_id, started_at, universe_total, status)
       VALUES (?, datetime('now'), ?, 'running')`,
    [runId, universeTotal]);
  saveDb();
}

function updatePipelineRun(runId, updates) {
  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  run(`UPDATE pipeline_runs SET ${cols} WHERE run_id = ?`, [...vals, runId]);
  saveDb();
}

function recordTickerStatus(runId, ticker, stage, status, reason) {
  run(`INSERT OR REPLACE INTO pipeline_ticker_status (run_id, ticker, stage, status, reason)
       VALUES (?, ?, ?, ?, ?)`,
    [runId, ticker, stage, status, reason || null]);
}

function getLatestPipelineRun() {
  return queryOne('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1');
}

function getPipelineRunById(runId) {
  const pipelineRun = queryOne('SELECT * FROM pipeline_runs WHERE run_id = ?', [runId]);
  if (!pipelineRun) return null;
  const tickerStatuses = query(
    'SELECT ticker, stage, status, reason FROM pipeline_ticker_status WHERE run_id = ? ORDER BY stage, ticker',
    [runId]
  );
  return { ...pipelineRun, tickerStatuses };
}

// ============================================================
// JOB QUEUE
// ============================================================

function enqueueJob(jobType, payload = {}, priority = 5) {
  run(`INSERT INTO jobs (job_type, payload, priority, status)
       VALUES (?, ?, ?, 'pending')`,
    [jobType, JSON.stringify(payload), priority]
  );
  saveDb();
}

function getNextJob() {
  return queryOne(`
    SELECT * FROM jobs 
    WHERE status = 'pending' 
    ORDER BY priority ASC, created_at ASC 
    LIMIT 1
  `);
}

function markJobRunning(jobId) {
  run("UPDATE jobs SET status = 'running', started_at = datetime('now') WHERE id = ?", [jobId]);
}

function markJobDone(jobId) {
  run("UPDATE jobs SET status = 'completed', finished_at = datetime('now') WHERE id = ?", [jobId]);
}

function markJobFailed(jobId, error) {
  run(`UPDATE jobs SET status = 'failed', finished_at = datetime('now'), 
       retries = retries + 1, error = ? WHERE id = ?`,
    [error, jobId]
  );
  // Re-queue if retries < 3
  const job = queryOne('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (job && job.retries < 3) {
    run("UPDATE jobs SET status = 'pending', finished_at = NULL WHERE id = ?", [jobId]);
  }
}

/**
 * Recover jobs stuck in 'running' state longer than their timeout.
 * Called before each drain cycle to prevent permanent queue blockage.
 */
function recoverStuckJobs() {
  const stuckJobs = query(
    "SELECT id, job_type, started_at FROM jobs WHERE status = 'running'"
  );
  for (const job of stuckJobs) {
    if (!job.started_at) continue;
    const startedAt = new Date(job.started_at.endsWith('Z') ? job.started_at : job.started_at + 'Z').getTime();
    const elapsed = Date.now() - startedAt;
    const timeout = getJobTimeout(job.job_type);
    if (elapsed > timeout) {
      console.warn(`[worker] ⏰ Job ${job.id} (${job.job_type}) timed out after ${Math.round(elapsed / 1000)}s — resetting`);
      run("UPDATE jobs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?",
        [`Timeout after ${Math.round(elapsed / 1000)}s`, job.id]);
      runningLocks.delete(job.job_type);
      saveDb();
    }
  }
}

// ============================================================
// JOB PROCESSORS
// ============================================================

const processors = {
  async ingest(payload) {
    const mode = payload.mode || 'incremental';
    if (mode === 'full') {
      await ingestAll(payload.lookbackDays || 365);
    } else {
      await ingestIncremental();
    }
    stats.lastIngest = new Date().toISOString();
  },

  async intraday5m(_payload) {
    await ingestIntraday5m();
    stats.lastIntraday5m = new Date().toISOString();
  },

  async features(_payload) {
    computeAllFeatures();
    stats.lastFeatures = new Date().toISOString();
  },

  async train(payload) {
    trainAll(payload);
    stats.lastTraining = new Date().toISOString();
  },

  async predict(payload) {
    const predictions = predictAll(payload.horizonDays || 5);
    generateAllSignals(predictions);
    stats.lastPrediction = new Date().toISOString();
  },

  async screener(_payload) {
    runScreener();
    // Auto-save daily picks and validate past picks
    const picksData = getDailyPicks();
    if (picksData.picks.length > 0) saveDailyPicks(picksData.picks);
    validatePastPicks();
    stats.lastScreener = new Date().toISOString();
  },

  /**
   * Continuous analysis pipeline — runs after each successful ingest.
   * Chains: features → predict → signals → screener → picks.
   * In degraded mode (low data coverage), still runs screener but flags results.
   * Tracks per-ticker status via run_id.
   */
  async analysis(payload) {
    const runId = generateRunId();
    stats.lastRunId = runId;
    console.log(`[worker] Running analysis pipeline (run_id=${runId})...`);

    const instruments = query("SELECT ticker FROM instruments WHERE active = 1");
    const universeTotal = instruments.length;
    createPipelineRun(runId, universeTotal);

    const cycleStats = getLastCycleStats();
    const coveragePct = cycleStats?.liveCoveragePct;
    const degraded = coveragePct != null && coveragePct < 80;
    const crisis = coveragePct != null && coveragePct < 60;

    // ---- CRISIS GUARD: halt analysis if coverage dangerously low ----
    if (crisis) {
      console.error(`[worker] 🚨 CRISIS: ingest coverage ${coveragePct}% < 60% — halting analysis, using last-known-good picks`);
      updatePipelineRun(runId, {
        finished_at: new Date().toISOString(),
        status: 'crisis',
        coverage_pct: coveragePct,
        degraded: 1,
        summary: JSON.stringify({ crisis: true, coveragePct, reason: 'Coverage below 60% crisis threshold' }),
      });
      stats.lastAnalysisCycle = new Date().toISOString();
      stats.analysisRuns++;
      return;
    }

    // ---- FEATURES ----
    let featuresOk = 0;
    try {
      computeAllFeatures();
      stats.lastFeatures = new Date().toISOString();
      // Count tickers with fresh features
      for (const { ticker } of instruments) {
        const feat = queryOne(
          "SELECT 1 FROM features WHERE ticker = ? AND date >= date('now', '-3 days')",
          [ticker]
        );
        if (feat) {
          featuresOk++;
          recordTickerStatus(runId, ticker, 'features', 'ok', null);
        } else {
          recordTickerStatus(runId, ticker, 'features', 'missing', 'No recent features');
        }
      }
    } catch (err) {
      console.error(`[worker] Features failed: ${err.message}`);
      updatePipelineRun(runId, { error: `features: ${err.message}` });
    }

    // ---- PREDICT ----
    let predictedOk = 0;
    try {
      const predictions = predictAll(payload.horizonDays || 5);
      generateAllSignals(predictions);
      stats.lastPrediction = new Date().toISOString();
      for (const { ticker } of instruments) {
        const pred = queryOne(
          "SELECT 1 FROM predictions WHERE ticker = ? AND created_at >= datetime('now', '-1 day')",
          [ticker]
        );
        if (pred) {
          predictedOk++;
          recordTickerStatus(runId, ticker, 'predict', 'ok', null);
        } else {
          recordTickerStatus(runId, ticker, 'predict', 'missing', 'No prediction generated');
        }
      }
    } catch (err) {
      console.error(`[worker] Predict failed: ${err.message}`);
      updatePipelineRun(runId, { error: `predict: ${err.message}` });
    }

    // ---- SCREENER (always runs, even degraded) ----
    let rankedOk = 0;
    try {
      const rankings = runScreener();
      rankedOk = rankings.length;
      stats.lastScreener = new Date().toISOString();

      for (const { ticker } of instruments) {
        const inRanking = rankings.find(r => r.ticker === ticker);
        if (inRanking) {
          recordTickerStatus(runId, ticker, 'ranking', 'ok', `score=${inRanking.score}`);
        } else {
          recordTickerStatus(runId, ticker, 'ranking', 'filtered', 'Did not pass hard filters');
        }
      }

      // Generate Daily Top 5 picks
      const picksData = getDailyPicks();
      if (picksData.picks.length > 0) saveDailyPicks(picksData.picks);
      validatePastPicks();
      stats.lastPicks = new Date().toISOString();

      if (degraded) {
        console.warn(`[worker] Degraded mode — screener ran but coverage low (${cycleStats?.liveCoveragePct}%)`);
      }
      console.log(`[worker] Daily picks: ${picksData.picks.map(p => p.ticker).join(', ') || '(none passed gates)'}`);

      // Precision KPI check
      const kpi = checkPrecisionKPI();
      if (kpi.retrain) {
        const alreadyTraining = queryOne(
          "SELECT 1 FROM jobs WHERE job_type = 'train' AND status IN ('pending','running')"
        );
        if (!alreadyTraining) {
          enqueueJob('train', { reason: 'precision_kpi', precision1D: kpi.precision1D }, 2);
          console.warn(`[worker] Emergency retrain enqueued (precision@1D=${kpi.precision1D}%)`);
        }
      }
    } catch (err) {
      console.error(`[worker] Screener failed: ${err.message}`);
      updatePipelineRun(runId, { error: `screener: ${err.message}` });
    }

    // ---- Finalize run ----
    const rankCoveragePct = universeTotal > 0 ? Math.round((rankedOk / universeTotal) * 1000) / 10 : 0;
    updatePipelineRun(runId, {
      finished_at: new Date().toISOString(),
      status: 'completed',
      ingested_ok: cycleStats?.liveCoveragePct ? Math.round(universeTotal * cycleStats.liveCoveragePct / 100) : 0,
      features_ok: featuresOk,
      predicted_ok: predictedOk,
      ranked_ok: rankedOk,
      coverage_pct: rankCoveragePct,
      degraded: degraded ? 1 : 0,
      summary: JSON.stringify({
        featuresOk, predictedOk, rankedOk, universeTotal, coveragePct: rankCoveragePct, degraded,
        ingestCoverage: cycleStats?.liveCoveragePct || null,
      }),
    });

    stats.lastAnalysisCycle = new Date().toISOString();
    stats.analysisRuns++;
    console.log(`[worker] Analysis pipeline complete (run_id=${runId}, run #${stats.analysisRuns}, ranked=${rankedOk}/${universeTotal}, coverage=${rankCoveragePct}%, degraded=${degraded})`);
  },

  async full_pipeline(_payload) {
    console.log('[worker] Running full pipeline...');
    await processors.ingest({ mode: 'incremental' });
    await processors.analysis({});
    console.log('[worker] Full pipeline complete.');
  },
};

// ============================================================
// JOB LOOP
// ============================================================

async function processNextJob() {
  const job = getNextJob();
  if (!job) return false;

  // Anti-overlap: skip if same job type is already running
  if (runningLocks.has(job.job_type)) {
    console.log(`[worker] Skipping job ${job.id} (${job.job_type}) — already running`);
    return true; // true = there are jobs, try next
  }

  const processor = processors[job.job_type];
  if (!processor) {
    markJobFailed(job.id, `Unknown job type: ${job.job_type}`);
    stats.jobsFailed++;
    return true;
  }

  runningLocks.add(job.job_type);
  markJobRunning(job.id);
  console.log(`[worker] Processing job ${job.id}: ${job.job_type}`);

  try {
    const payload = job.payload ? JSON.parse(job.payload) : {};
    const jobTimeout = getJobTimeout(job.job_type);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Job execution timeout after ${jobTimeout / 1000}s`)), jobTimeout)
    );
    await Promise.race([processor(payload), timeoutPromise]);
    markJobDone(job.id);
    stats.jobsProcessed++;

    // Chain: after successful ingest, auto-enqueue analysis
    if (job.job_type === 'ingest') {
      const alreadyQueued = queryOne(
        "SELECT 1 FROM jobs WHERE job_type = 'analysis' AND status IN ('pending','running')"
      );
      if (!alreadyQueued) {
        enqueueJob('analysis', {}, 4);
        console.log('[worker] Auto-enqueued analysis after ingest');
      } else {
        console.log('[worker] Analysis already queued/running — skipping auto-enqueue');
      }
    }

    run(`INSERT INTO audit_log (event_type, entity, entity_id, payload)
         VALUES ('JOB_COMPLETED', 'job', ?, ?)`,
      [String(job.id), JSON.stringify({ type: job.job_type })]
    );
    saveDb();
    console.log(`[worker] Job ${job.id} completed`);
  } catch (err) {
    markJobFailed(job.id, err.message);
    stats.jobsFailed++;
    console.error(`[worker] Job ${job.id} failed:`, err.message);
  } finally {
    runningLocks.delete(job.job_type);
  }

  return true;
}

async function drainQueue() {
  recoverStuckJobs();
  let processed = 0;
  while (await processNextJob()) {
    processed++;
    if (processed > 50) break; // safety limit per cycle
  }
  return processed;
}

// ============================================================
// HELPER: current mode based on Warsaw time
// ============================================================
function getCurrentMode() {
  const now = new Date();
  // Warsaw offset: CET=+1, CEST=+2
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const warsawOffset = isDST(now) ? 2 : 1;
  const warsaw = new Date(utc + warsawOffset * 3600000);
  const hour = warsaw.getHours();
  const dow = warsaw.getDay(); // 0=Sun, 6=Sat

  if (dow === 0 || dow === 6) return 'off-hours'; // weekend
  if (hour >= 9 && hour < 17) return 'market';
  if (hour >= 17 && hour < 23) return 'off-hours';
  return 'night';
}

function isDST(d) {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul);
}

// ============================================================
// SCHEDULER (cron-based, session-aware)
// ============================================================

function startScheduler() {
  if (isRunning) return;
  isRunning = true;
  stats.startedAt = new Date().toISOString();
  console.log('[worker] Starting 24/7 session-aware scheduler...');

  // Recover jobs stuck in 'running' state from previous crash
  const stuck = query("SELECT id FROM jobs WHERE status = 'running'");
  if (stuck.length > 0) {
    run("UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'");
    saveDb();
    console.log(`[worker] Recovered ${stuck.length} stuck jobs → pending`);
  }

  // Clean old completed/failed jobs (keep last 500)
  run(`DELETE FROM jobs WHERE id NOT IN (
    SELECT id FROM jobs ORDER BY created_at DESC LIMIT 500
  ) AND status IN ('completed','failed')`);

  // ========== MARKET HOURS (Mon-Fri 9-17): aggressive ==========

  // Ingest every 15 min
  cron.schedule('*/15 9-16 * * 1-5', () => {
    stats.mode = 'market';
    console.log('[cron:market] Enqueueing incremental ingest');
    enqueueJob('ingest', { mode: 'incremental' }, 3);
    drainQueue().catch(console.error);
  }, { timezone: TIMEZONE });

  // 5-minute intraday ingest every 5 min during market hours (GPW API)
  cron.schedule('*/5 9-16 * * 1-5', () => {
    stats.mode = 'market';
    enqueueJob('intraday5m', {}, 4);
    drainQueue().catch(console.error);
  }, { timezone: TIMEZONE });

  // ========== OFF-HOURS (Mon-Fri 17-22, weekends 8-22): eco mode ==========

  // Ingest every 60 min (data won't change much, but catch corrections)
  cron.schedule('0 17-22 * * 1-5', () => {
    stats.mode = 'off-hours';
    console.log('[cron:off-hours] Eco ingest');
    enqueueJob('ingest', { mode: 'incremental' }, 5);
    drainQueue().catch(console.error);
  }, { timezone: TIMEZONE });

  // Weekend ingest twice a day (catch corrections/corporate actions)
  cron.schedule('0 10,18 * * 0,6', () => {
    stats.mode = 'off-hours';
    console.log('[cron:weekend] Eco ingest');
    enqueueJob('ingest', { mode: 'incremental' }, 5);
    drainQueue().catch(console.error);
  }, { timezone: TIMEZONE });

  // ========== DAILY TRAINING (18:00 Mon-Fri) ==========
  cron.schedule('0 18 * * 1-5', () => {
    console.log('[cron] Enqueueing daily training');
    enqueueJob('train', {}, 2);
    drainQueue().catch(console.error);
  }, { timezone: TIMEZONE });

  // ========== WEEKEND DEEP RETRAINING (Saturday 8:00) ==========
  cron.schedule('0 8 * * 6', () => {
    console.log('[cron:weekend] Full ingest + deep retrain');
    enqueueJob('ingest', { mode: 'full', lookbackDays: 90 }, 1);
    enqueueJob('train', {}, 2);
    drainQueue().catch(console.error);
  }, { timezone: TIMEZONE });

  // ========== QUEUE DRAIN safety net (every 2 min, 24/7) ==========
  cron.schedule('*/2 * * * *', () => {
    stats.mode = getCurrentMode();
    drainQueue().catch(console.error);
  });

  console.log('[worker] Scheduler started — market(15m) | off-hours(60m) | night(drain-only)');
}

function stopScheduler() {
  isRunning = false;
  cron.getTasks().forEach(task => task.stop());
  console.log('[worker] Scheduler stopped');
}

// ============================================================
// ALERTING — detect operational anomalies
// ============================================================
const ALERT_THRESHOLDS = {
  maxIngestGapMinutes: 20,     // max gap between ingests during market hours
  maxAnalysisGapMinutes: 20,   // max gap between analysis runs during market hours
  maxStalePicksMinutes: 15,    // max age of rankedAt before alert
  minIngestCoveragePct: 90,    // ingest coverage alarm threshold
};

function checkAlerts() {
  const mode = getCurrentMode();
  const alerts = [];
  const now = Date.now();

  // Only check time-based alerts during market hours
  if (mode === 'market') {
    if (stats.lastIngest) {
      const gap = (now - new Date(stats.lastIngest).getTime()) / 60000;
      if (gap > ALERT_THRESHOLDS.maxIngestGapMinutes) {
        alerts.push({ level: 'warning', type: 'ingest_gap', message: `No ingest for ${Math.round(gap)} min (threshold: ${ALERT_THRESHOLDS.maxIngestGapMinutes})` });
      }
    } else if (stats.startedAt) {
      const upMin = (now - new Date(stats.startedAt).getTime()) / 60000;
      if (upMin > ALERT_THRESHOLDS.maxIngestGapMinutes) {
        alerts.push({ level: 'critical', type: 'no_ingest', message: `Worker running ${Math.round(upMin)} min without any ingest` });
      }
    }

    if (stats.lastAnalysisCycle) {
      const gap = (now - new Date(stats.lastAnalysisCycle).getTime()) / 60000;
      if (gap > ALERT_THRESHOLDS.maxAnalysisGapMinutes) {
        alerts.push({ level: 'warning', type: 'analysis_gap', message: `No analysis for ${Math.round(gap)} min (threshold: ${ALERT_THRESHOLDS.maxAnalysisGapMinutes})` });
      }
    }
  }

  // Stuck jobs check (all modes)
  if (runningLocks.size > 0) {
    const stuckJobs = query("SELECT id, job_type, started_at FROM jobs WHERE status = 'running'");
    for (const job of stuckJobs) {
      if (!job.started_at) continue;
      const startedAt = new Date(job.started_at.endsWith('Z') ? job.started_at : job.started_at + 'Z').getTime();
      const elapsed = (now - startedAt) / 60000;
      const timeout = getJobTimeout(job.job_type) / 60000;
      if (elapsed > timeout * 0.8) {
        alerts.push({ level: 'warning', type: 'near_timeout', message: `Job ${job.id} (${job.job_type}) running ${Math.round(elapsed)} min (timeout: ${Math.round(timeout)})` });
      }
    }
  }

  // Ingest coverage check
  const lastCycle = require('../ingest/ingestPipeline').getLastCycleStats();
  if (lastCycle && lastCycle.liveCoveragePct < ALERT_THRESHOLDS.minIngestCoveragePct) {
    alerts.push({ level: 'warning', type: 'low_coverage', message: `Ingest coverage ${lastCycle.liveCoveragePct}% < ${ALERT_THRESHOLDS.minIngestCoveragePct}%` });
  }

  // Crisis coverage check
  if (lastCycle && lastCycle.liveCoveragePct < 60) {
    alerts.push({ level: 'critical', type: 'crisis_coverage', message: `Ingest coverage ${lastCycle.liveCoveragePct}% < 60% — analysis halted (crisis mode)` });
  }

  // Precision KPI check
  const kpi = lastPrecisionCheck;
  if (kpi && kpi.precision1D != null) {
    if (kpi.precision1D < PRECISION_RETRAIN_THRESHOLD) {
      alerts.push({ level: 'critical', type: 'precision_critical', message: `Model precision@1D=${kpi.precision1D}% < ${PRECISION_RETRAIN_THRESHOLD}%` });
    } else if (kpi.precision1D < PRECISION_WARN_THRESHOLD) {
      alerts.push({ level: 'warning', type: 'precision_warn', message: `Model precision@1D=${kpi.precision1D}% < ${PRECISION_WARN_THRESHOLD}%` });
    }
  }

  // Log critical alerts
  for (const a of alerts) {
    if (a.level === 'critical') console.error(`[alert] 🚨 ${a.message}`);
    else if (a.level === 'warning') console.warn(`[alert] ⚠️ ${a.message}`);
  }

  return alerts;
}

// ============================================================
// STATUS
// ============================================================

function getWorkerStatus() {
  const pendingJobs = queryOne("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'pending'");
  const runningJobs = queryOne("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'running'");
  const failedJobs = queryOne("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'failed' AND retries >= 3");
  const recentJobs = query(`
    SELECT id, job_type, status, created_at, finished_at, retries, error
    FROM jobs ORDER BY created_at DESC LIMIT 10
  `);

  const lastCycle = require('../ingest/ingestPipeline').getLastCycleStats();
  const latestRun = getLatestPipelineRun();

  return {
    isRunning,
    currentMode: getCurrentMode(),
    ...stats,
    queueSize: pendingJobs?.cnt || 0,
    runningCount: runningJobs?.cnt || 0,
    failedCount: failedJobs?.cnt || 0,
    activeLocks: [...runningLocks],
    recentJobs,
    lastIngestCycle: lastCycle ? {
      liveCoveragePct: lastCycle.liveCoveragePct,
      batchCoveragePct: lastCycle.batchCoveragePct,
      httpCalls: lastCycle.httpCalls,
      budgetExhausted: lastCycle.budgetExhausted || false,
      rateLimited: lastCycle.rateLimited,
      timestamp: lastCycle.timestamp,
    } : null,
    lastPipelineRun: latestRun ? {
      runId: latestRun.run_id,
      status: latestRun.status,
      universeTotal: latestRun.universe_total,
      rankedOk: latestRun.ranked_ok,
      coveragePct: latestRun.coverage_pct,
      degraded: !!latestRun.degraded,
      startedAt: latestRun.started_at,
      finishedAt: latestRun.finished_at,
    } : null,
  };
}

module.exports = {
  enqueueJob,
  drainQueue,
  processNextJob,
  startScheduler,
  stopScheduler,
  getWorkerStatus,
  processors,
  getCurrentMode,
  getPrecisionKPI,
  getLatestPipelineRun,
  getPipelineRunById,
  checkAlerts,
};

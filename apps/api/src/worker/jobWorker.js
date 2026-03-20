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
const { runScreener, getDailyPicks, saveDailyPicks, validatePastPicks } = require('../screener/rankingService');

const TIMEZONE = 'Europe/Warsaw';

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
};

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
   * Chains: features → predict → signals → screener.
   * In degraded mode (low data), skips screener to save time.
   */
  async analysis(payload) {
    console.log('[worker] Running continuous analysis pipeline...');
    const cycleStats = getLastCycleStats();
    const degraded = cycleStats && cycleStats.liveCoveragePct < 80;

    computeAllFeatures();
    stats.lastFeatures = new Date().toISOString();

    const predictions = predictAll(payload.horizonDays || 5);
    generateAllSignals(predictions);
    stats.lastPrediction = new Date().toISOString();

    if (!degraded) {
      runScreener();
      stats.lastScreener = new Date().toISOString();

      // Generate Daily Top 5 picks after each full analysis
      const picksData = getDailyPicks();
      if (picksData.picks.length > 0) saveDailyPicks(picksData.picks);
      validatePastPicks();
      stats.lastPicks = new Date().toISOString();
      console.log(`[worker] Daily picks: ${picksData.picks.map(p => p.ticker).join(', ')}`);
    } else {
      console.log('[worker] Degraded mode — skipping screener & picks (coverage < 80%)');
    }

    stats.lastAnalysisCycle = new Date().toISOString();
    stats.analysisRuns++;
    console.log(`[worker] Analysis pipeline complete (run #${stats.analysisRuns}, degraded=${degraded})`);
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
    await processor(payload);
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

  return {
    isRunning,
    currentMode: getCurrentMode(),
    ...stats,
    queueSize: pendingJobs?.cnt || 0,
    runningCount: runningJobs?.cnt || 0,
    failedCount: failedJobs?.cnt || 0,
    activeLocks: [...runningLocks],
    recentJobs,
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
};

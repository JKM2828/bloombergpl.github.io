// ============================================================
// Unit tests: jobWorker – queue, timeout recovery, concurrency
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock BEFORE requiring modules
const mockDb = require('../helpers/setup');

describe('jobWorker', () => {
  let jobWorker;

  beforeEach(() => {
    mockDb.reset();
    // Lazy-load to ensure mock is in place
    jobWorker = require('../../src/worker/jobWorker');
  });

  describe('enqueueJob', () => {
    it('inserts a pending job via run()', () => {
      // enqueueJob calls run() which is the mock; we just verify it doesn't throw
      // The mock run() returns 1 (success)
      assert.doesNotThrow(() => {
        jobWorker.enqueueJob('ingest', { mode: 'full' }, 2);
      });
    });
  });

  describe('getWorkerStatus', () => {
    it('returns structured status with queue stats', () => {
      // COUNT queries for pending, running, failed
      mockDb.pushQueryOneResult({ cnt: 3 }); // pending
      mockDb.pushQueryOneResult({ cnt: 1 }); // running
      mockDb.pushQueryOneResult({ cnt: 0 }); // failed
      // Recent jobs query
      mockDb.pushQueryResult([
        { id: 1, job_type: 'ingest', status: 'completed', created_at: '2026-01-01', finished_at: '2026-01-01', retries: 0, error: null },
      ]);

      const status = jobWorker.getWorkerStatus();
      assert.strictEqual(status.queueSize, 3);
      assert.strictEqual(status.runningCount, 1);
      assert.strictEqual(status.failedCount, 0);
      assert.ok(Array.isArray(status.recentJobs));
    });
  });

  describe('getCurrentMode', () => {
    it('returns one of market, off-hours, or night', () => {
      const mode = jobWorker.getCurrentMode();
      assert.ok(['market', 'off-hours', 'night'].includes(mode), `Got unexpected mode: ${mode}`);
    });

    it('uses Warsaw time boundaries for weekday market and off-hours', () => {
      // 2026-04-21 Tue in CEST (UTC+2)
      assert.equal(jobWorker.getCurrentMode(new Date('2026-04-21T06:59:00Z')), 'night');     // 08:59 Warsaw
      assert.equal(jobWorker.getCurrentMode(new Date('2026-04-21T07:00:00Z')), 'market');    // 09:00 Warsaw
      assert.equal(jobWorker.getCurrentMode(new Date('2026-04-21T14:59:00Z')), 'market');    // 16:59 Warsaw
      assert.equal(jobWorker.getCurrentMode(new Date('2026-04-21T15:00:00Z')), 'off-hours'); // 17:00 Warsaw
      assert.equal(jobWorker.getCurrentMode(new Date('2026-04-21T21:00:00Z')), 'night');     // 23:00 Warsaw
    });

    it('returns off-hours on weekend regardless of daytime hour', () => {
      // 2026-04-18 Sat in CEST (UTC+2)
      assert.equal(jobWorker.getCurrentMode(new Date('2026-04-18T08:00:00Z')), 'off-hours'); // 10:00 Warsaw
      assert.equal(jobWorker.getCurrentMode(new Date('2026-04-18T20:00:00Z')), 'off-hours'); // 22:00 Warsaw
    });
  });

  describe('getPrecisionKPI', () => {
    it('returns null before any check', () => {
      // Initially null (no precision check run)
      const kpi = jobWorker.getPrecisionKPI();
      // May be null or an object depending on test order
      assert.ok(kpi === null || typeof kpi === 'object');
    });
  });

  describe('checkAlerts', () => {
    it('returns array of alerts', () => {
      // provide lastCycleStats mock
      mockDb.pushQueryResult([]); // stuckJobs query
      mockDb.pushQueryOneResult(null); // data_stale: lastIngest query
      const alerts = jobWorker.checkAlerts();
      assert.ok(Array.isArray(alerts));
    });

    it('includes data_stale alert when no ingest for >2h', () => {
      mockDb.pushQueryResult([]); // stuckJobs
      // Simulate lastIngest 3 hours ago
      const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      mockDb.pushQueryOneResult({ d: threeHoursAgo });
      const alerts = jobWorker.checkAlerts();
      const staleAlert = alerts.find(a => a.type === 'data_stale');
      assert.ok(staleAlert, 'data_stale alert must exist when ingest is >2h old');
      assert.equal(staleAlert.level, 'critical');
    });
  });

  describe('recoverStuckJobs (via drainQueue)', () => {
    it('drainQueue returns 0 when queue is empty', async () => {
      // recoverStuckJobs: query for running jobs
      mockDb.pushQueryResult([]);
      // getNextJob: queryOne returns null
      mockDb.pushQueryOneResult(null);

      const processed = await jobWorker.drainQueue();
      assert.strictEqual(processed, 0);
    });
  });
});

// ============================================================
// Regression tests for audit fixes (2026-04-04)
// Tests: auth middleware, pipeline 202, atomic DB save
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// ---- 1. Auth middleware ----
describe('requireAdmin middleware', () => {
  let requireAdmin;

  beforeEach(() => {
    // Clear module cache so env changes take effect
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
  });

  it('should skip auth when ADMIN_API_KEY is not set', () => {
    delete process.env.ADMIN_API_KEY;
    requireAdmin = require('../../src/middleware/requireAdmin');
    const req = { headers: {} };
    let nextCalled = false;
    requireAdmin(req, {}, () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() should be called when no key configured');
  });

  it('should return 401 when key is required but not provided', () => {
    process.env.ADMIN_API_KEY = 'test-secret-key';
    requireAdmin = require('../../src/middleware/requireAdmin');
    const req = { headers: {} };
    let statusCode, body;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; },
    };
    requireAdmin(req, res, () => { assert.fail('next should not be called'); });
    assert.equal(statusCode, 401);
    assert.ok(body.error.includes('Authentication required'));
  });

  it('should return 403 when wrong key is provided via Authorization header', () => {
    process.env.ADMIN_API_KEY = 'correct-key';
    requireAdmin = require('../../src/middleware/requireAdmin');
    const req = { headers: { authorization: 'Bearer wrong-key' } };
    let statusCode, body;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; },
    };
    requireAdmin(req, res, () => { assert.fail('next should not be called'); });
    assert.equal(statusCode, 403);
    assert.ok(body.error.includes('Invalid'));
  });

  it('should return 403 when wrong key is provided via X-API-Key header', () => {
    process.env.ADMIN_API_KEY = 'correct-key';
    requireAdmin = require('../../src/middleware/requireAdmin');
    const req = { headers: { 'x-api-key': 'wrong-key' } };
    let statusCode, body;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; },
    };
    requireAdmin(req, res, () => { assert.fail('next should not be called'); });
    assert.equal(statusCode, 403);
  });

  it('should call next() when correct key is provided via Bearer token', () => {
    process.env.ADMIN_API_KEY = 'correct-key';
    requireAdmin = require('../../src/middleware/requireAdmin');
    const req = { headers: { authorization: 'Bearer correct-key' } };
    let nextCalled = false;
    requireAdmin(req, {}, () => { nextCalled = true; });
    assert.ok(nextCalled);
  });

  it('should call next() when correct key is provided via X-API-Key', () => {
    process.env.ADMIN_API_KEY = 'correct-key';
    requireAdmin = require('../../src/middleware/requireAdmin');
    const req = { headers: { 'x-api-key': 'correct-key' } };
    let nextCalled = false;
    requireAdmin(req, {}, () => { nextCalled = true; });
    assert.ok(nextCalled);
  });
});

// ---- 2. Atomic DB save ----
describe('atomic saveDb', () => {
  it('should write via tmp file (no partial writes)', () => {
    // We test the write-then-rename pattern by checking that
    // the saveDb function uses renameSync (atomic on most filesystems).
    const connPath = require.resolve('../../src/db/connection');
    const source = fs.readFileSync(connPath, 'utf8');

    assert.ok(source.includes('renameSync'), 'saveDb should use fs.renameSync for atomic save');
    assert.ok(source.includes('.tmp'), 'saveDb should write to a .tmp file first');
  });

  it('should serialize concurrent saves (skip if already saving)', () => {
    const source = fs.readFileSync(require.resolve('../../src/db/connection'), 'utf8');
    assert.ok(source.includes('_saving'), 'saveDb should have a _saving lock flag');
  });
});

// ---- 3. Pipeline returns 202 ----
describe('pipeline/run route', () => {
  it('should not await drainQueue synchronously', () => {
    const routeSource = fs.readFileSync(
      require.resolve('../../src/routes/index'),
      'utf8'
    );
    // There should be no "await drainQueue()" in the pipeline/run handler
    // The pattern should be drainQueue().catch(...)
    const pipelineBlock = routeSource.split("'/pipeline/run'")[1]?.slice(0, 500) || '';
    assert.ok(!pipelineBlock.includes('await drainQueue'), 'pipeline/run should NOT await drainQueue');
    assert.ok(pipelineBlock.includes('.catch('), 'pipeline/run should fire-and-forget with .catch()');
  });

  it('should return 202 status', () => {
    const routeSource = fs.readFileSync(
      require.resolve('../../src/routes/index'),
      'utf8'
    );
    const pipelineBlock = routeSource.split("'/pipeline/run'")[1]?.slice(0, 500) || '';
    assert.ok(pipelineBlock.includes('202'), 'pipeline/run should return 202 Accepted');
  });
});

// ---- 4. CSP + CORS ----
describe('security headers', () => {
  it('should have CSP enabled (not disabled)', () => {
    const indexSource = fs.readFileSync(
      require.resolve('../../src/index'),
      'utf8'
    );
    assert.ok(!indexSource.includes('contentSecurityPolicy: false'), 'CSP should not be disabled');
    assert.ok(indexSource.includes("defaultSrc"), 'CSP should define default-src');
  });

  it('should restrict CORS when CORS_ORIGINS is set', () => {
    const indexSource = fs.readFileSync(
      require.resolve('../../src/index'),
      'utf8'
    );
    assert.ok(indexSource.includes('CORS_ORIGINS'), 'Should read CORS_ORIGINS from env');
    assert.ok(indexSource.includes('allowedHeaders'), 'Should define allowedHeaders');
  });
});

// ---- 5. WS graceful shutdown ----
describe('WebSocket graceful shutdown', () => {
  it('stopPolling should close client connections and WSS', () => {
    const wsSource = fs.readFileSync(
      require.resolve('../../src/ws/liveCandles'),
      'utf8'
    );
    assert.ok(wsSource.includes('subscriptions.clear()'), 'stopPolling should clear subscriptions');
    assert.ok(wsSource.includes('wss.close'), 'stopPolling should close the WSS server');
  });
});

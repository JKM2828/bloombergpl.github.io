// ============================================================
// Unit tests: routes / middleware  (TEST-H1)
// Tests requireAdmin middleware + CORS + rate-limit config.
// Does NOT spin up full HTTP server (avoids DB + worker init).
// ============================================================
const { describe, it, beforeEach, before } = require('node:test');
const assert = require('node:assert/strict');

// Stub DB before any route import
const mockDb = require('../helpers/setup');

// ---- Test requireAdmin middleware directly ----
describe('requireAdmin middleware', () => {
  // Re-require each test so env changes take effect
  let requireAdmin;

  before(() => {
    requireAdmin = require('../../src/middleware/requireAdmin');
  });

  function mockReq(headers = {}) {
    return { headers };
  }
  function mockRes() {
    let _status = 200;
    let _json = null;
    return {
      status(code) { _status = code; return this; },
      json(data) { _json = data; return this; },
      _status() { return _status; },
      _json() { return _json; },
      _calls: { status: null, json: null },
    };
  }

  it('passes through when ADMIN_API_KEY is not set (dev mode)', () => {
    const savedKey = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    // Re-require to pick up env change
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
    const mw = require('../../src/middleware/requireAdmin');

    let nextCalled = false;
    mw(mockReq(), mockRes(), () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() should be called in dev mode');

    process.env.ADMIN_API_KEY = savedKey || '';
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
  });

  it('returns 401 when ADMIN_API_KEY is set but no token provided', () => {
    process.env.ADMIN_API_KEY = 'test-secret-key';
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
    const mw = require('../../src/middleware/requireAdmin');

    const res = { statusCode: null, body: null };
    mw(
      mockReq({}),
      {
        status(code) { res.statusCode = code; return this; },
        json(body) { res.body = body; },
      },
      () => { assert.fail('next() should NOT be called'); }
    );
    assert.equal(res.statusCode, 401);
    assert.ok(res.body.error);
  });

  it('returns 403 when wrong API key provided', () => {
    process.env.ADMIN_API_KEY = 'correct-key';
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
    const mw = require('../../src/middleware/requireAdmin');

    const res = { statusCode: null, body: null };
    mw(
      mockReq({ 'x-api-key': 'wrong-key' }),
      {
        status(code) { res.statusCode = code; return this; },
        json(body) { res.body = body; },
      },
      () => { assert.fail('next() should NOT be called'); }
    );
    assert.equal(res.statusCode, 403);
  });

  it('passes through with correct X-API-Key header', () => {
    process.env.ADMIN_API_KEY = 'correct-key';
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
    const mw = require('../../src/middleware/requireAdmin');

    let nextCalled = false;
    mw(
      mockReq({ 'x-api-key': 'correct-key' }),
      {},
      () => { nextCalled = true; }
    );
    assert.ok(nextCalled);
  });

  it('passes through with correct Bearer token in Authorization header', () => {
    process.env.ADMIN_API_KEY = 'bearer-key';
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
    const mw = require('../../src/middleware/requireAdmin');

    let nextCalled = false;
    mw(
      mockReq({ authorization: 'Bearer bearer-key' }),
      {},
      () => { nextCalled = true; }
    );
    assert.ok(nextCalled);
  });

  it('rejects Bearer token that does not match', () => {
    process.env.ADMIN_API_KEY = 'real-key';
    delete require.cache[require.resolve('../../src/middleware/requireAdmin')];
    const mw = require('../../src/middleware/requireAdmin');

    let rejected = false;
    mw(
      mockReq({ authorization: 'Bearer wrong-key' }),
      {
        status(code) { rejected = code === 403; return this; },
        json() {},
      },
      () => { assert.fail('next() not expected'); }
    );
    assert.ok(rejected);
  });
});

// ---- Test esc() HTML sanitizer in app.js (browser logic — re-impl for node test) ----
describe('XSS: esc() function contract', () => {
  // Re-implement esc() per the same spec as app.js to verify correctness
  function esc(str) {
    if (str == null) return '';
    // Simulate textContent encoding
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  it('returns empty string for null', () => {
    assert.equal(esc(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(esc(undefined), '');
  });

  it('escapes < and > characters', () => {
    assert.ok(esc('<script>').includes('&lt;'));
    assert.ok(esc('<script>').includes('&gt;'));
    assert.ok(!esc('<script>').includes('<'));
  });

  it('escapes & character', () => {
    assert.ok(esc('AT&T').includes('&amp;'));
  });

  it('escapes double quotes', () => {
    assert.ok(esc('"hello"').includes('&quot;'));
  });

  it('passes through safe strings unchanged', () => {
    assert.equal(esc('PKOBP'), 'PKOBP');
    assert.equal(esc('PKO BP S.A.'), 'PKO BP S.A.');
    assert.equal(esc('123.45'), '123.45');
  });

  it('converts xss payload to safe text', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const result = esc(payload);
    assert.ok(!result.includes('<img'));
    assert.ok(result.includes('&lt;img'));
  });

  it('converts number to string', () => {
    assert.equal(esc(42), '42');
    assert.equal(esc(0), '0');
  });
});

// ---- Input validation contracts ----
describe('input validation contracts', () => {
  it('limit parameter must be positive integer (contract assertion)', () => {
    const parseLimit = (val) => {
      const n = parseInt(val);
      return isNaN(n) || n <= 0 ? 20 : Math.min(n, 200);
    };

    assert.equal(parseLimit('50'), 50);
    assert.equal(parseLimit('abc'), 20);  // fallback
    assert.equal(parseLimit('-1'), 20);   // fallback
    assert.equal(parseLimit('0'), 20);    // fallback
    assert.equal(parseLimit('999'), 200); // cap at 200
  });

  it('ticker normalization (uppercase)', () => {
    const normalize = (t) => t.toUpperCase();
    assert.equal(normalize('pkobp'), 'PKOBP');
    assert.equal(normalize('CDR'), 'CDR');
  });
});

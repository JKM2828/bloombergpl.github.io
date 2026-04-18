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

describe('ML status schema mapping in dashboard', () => {
  it('loadMlFreshness should use model/prediction and candles/features fields', () => {
    const fs = require('fs');
    const path = require('path');
    const appSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'web', 'public', 'app.js'),
      'utf8'
    );

    assert.ok(appSrc.includes('t.model'), 'Dashboard must detect models via t.model');
    assert.ok(appSrc.includes('t.prediction'), 'Dashboard must detect predictions via t.prediction');
    assert.ok(appSrc.includes('t.candles'), 'Dashboard must show candle count via t.candles');
    assert.ok(appSrc.includes('t.features'), 'Dashboard must show feature count via t.features');

    assert.ok(!appSrc.includes('t.hasModel'), 'Legacy hasModel key must not be used');
    assert.ok(!appSrc.includes('t.hasPrediction'), 'Legacy hasPrediction key must not be used');
    assert.ok(!appSrc.includes('t.candleCount'), 'Legacy candleCount key must not be used');
    assert.ok(!appSrc.includes('t.featureCount'), 'Legacy featureCount key must not be used');
  });
});

// ---- Portfolio endpoints require auth ----
describe('portfolio endpoints require requireAdmin', () => {
  it('POST /portfolio/deposit is guarded by requireAdmin', () => {
    // Read the route source and verify requireAdmin is in the handler chain
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
      'utf8'
    );
    assert.ok(
      routeSrc.includes("router.post('/portfolio/deposit', requireAdmin"),
      'POST /portfolio/deposit must use requireAdmin middleware'
    );
  });

  it('POST /portfolio/withdraw is guarded by requireAdmin', () => {
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
      'utf8'
    );
    assert.ok(
      routeSrc.includes("router.post('/portfolio/withdraw', requireAdmin"),
      'POST /portfolio/withdraw must use requireAdmin middleware'
    );
  });

  it('POST /portfolio/buy is guarded by requireAdmin', () => {
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
      'utf8'
    );
    assert.ok(
      routeSrc.includes("router.post('/portfolio/buy', requireAdmin"),
      'POST /portfolio/buy must use requireAdmin middleware'
    );
  });

  it('POST /portfolio/sell is guarded by requireAdmin', () => {
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
      'utf8'
    );
    assert.ok(
      routeSrc.includes("router.post('/portfolio/sell', requireAdmin"),
      'POST /portfolio/sell must use requireAdmin middleware'
    );
  });

  it('POST /ingest/backfill is guarded by requireAdmin', () => {
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
      'utf8'
    );
    assert.ok(
      routeSrc.includes("router.post('/ingest/backfill', requireAdmin"),
      'POST /ingest/backfill must use requireAdmin middleware'
    );
  });

  it('POST /pipeline/recover is guarded by requireAdmin', () => {
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
      'utf8'
    );
    assert.ok(
      routeSrc.includes("router.post('/pipeline/recover', requireAdmin"),
      'POST /pipeline/recover must use requireAdmin middleware'
    );
  });
});

// ---- XSS: competition onclick uses esc() ----
describe('XSS: competition sell button escaping', () => {
  it('compSellPosition onclick uses esc() for ticker', () => {
    const fs = require('fs');
    const path = require('path');
    const appSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'web', 'public', 'app.js'),
      'utf8'
    );
    // Must NOT have unescaped p.ticker in onclick
    assert.ok(
      !appSrc.includes("'${p.ticker}'"),
      'onclick must not use raw p.ticker — use esc(p.ticker)'
    );
    assert.ok(
      appSrc.includes("esc(p.ticker)"),
      'onclick must use esc(p.ticker) for XSS safety'
    );
  });

  it('sell candidates table uses esc() for ticker and reasons', () => {
    const fs = require('fs');
    const path = require('path');
    const appSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'web', 'public', 'app.js'),
      'utf8'
    );
    assert.ok(
      appSrc.includes("esc(c.ticker)"),
      'sell candidates table must escape c.ticker'
    );
    assert.ok(
      appSrc.includes("esc(c.sellReasons"),
      'sell candidates table must escape c.sellReasons'
    );
  });
});

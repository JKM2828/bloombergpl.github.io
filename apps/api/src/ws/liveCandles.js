// ============================================================
// WebSocket Live Feed – real-time candle updates via GPW API
//
// Clients connect: ws://host:port/ws/live?ticker=PKN&tf=5m
// Server polls GPW quote API and broadcasts candle updates.
//
// Supports:
//   - Per-ticker subscriptions (multiple tickers per client)
//   - Heartbeat (30s ping/pong)
//   - Backpressure-safe broadcast (skip slow clients)
//   - Automatic fallback detection for frontend reconnect
// ============================================================
const { WebSocketServer } = require('ws');
const gpwProvider = require('../providers/gpwProvider');

// ---- Config ----
const POLL_INTERVAL_MS = parseInt(process.env.LIVE_POLL_INTERVAL_MS || '30000', 10); // 30s
const HEARTBEAT_INTERVAL_MS = 30000;

// ---- State ----
// Map<subscriptionKey, Set<ws>> — subscriptionKey = "TICKER:TF"
const subscriptions = new Map();
// Map<ws, {alive, tickers: Set<string>}>
const clients = new Map();
// Cache of last broadcasted candle per ticker (to avoid redundant pushes)
const lastCandle = new Map();
// Polling timer
let pollTimer = null;
let heartbeatTimer = null;
let wss = null;

/**
 * Attach WebSocket server to an existing HTTP server.
 * @param {import('http').Server} server
 */
function attachWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws/live' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase();
    const tf = url.searchParams.get('tf') || '5m';

    if (!ticker) {
      ws.close(4000, 'Missing ticker parameter');
      return;
    }

    const subKey = `${ticker}:${tf}`;
    clients.set(ws, { alive: true, tickers: new Set([subKey]) });

    if (!subscriptions.has(subKey)) {
      subscriptions.set(subKey, new Set());
    }
    subscriptions.get(subKey).add(ws);

    console.log(`[ws] Client subscribed: ${subKey} (total: ${wss.clients.size})`);

    // Send last known candle immediately (bootstrap)
    const cached = lastCandle.get(ticker);
    if (cached) {
      safeSend(ws, JSON.stringify({ type: 'candle', ticker, timeframe: tf, candle: cached }));
    }

    // Handle messages (subscribe to additional tickers)
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.action === 'subscribe' && msg.ticker) {
          const newKey = `${msg.ticker.toUpperCase()}:${msg.tf || '5m'}`;
          const clientState = clients.get(ws);
          if (clientState) {
            clientState.tickers.add(newKey);
          }
          if (!subscriptions.has(newKey)) {
            subscriptions.set(newKey, new Set());
          }
          subscriptions.get(newKey).add(ws);
          // Bootstrap cached candle for new sub
          const c = lastCandle.get(msg.ticker.toUpperCase());
          if (c) {
            safeSend(ws, JSON.stringify({ type: 'candle', ticker: msg.ticker.toUpperCase(), timeframe: msg.tf || '5m', candle: c }));
          }
        } else if (msg.action === 'unsubscribe' && msg.ticker) {
          const oldKey = `${msg.ticker.toUpperCase()}:${msg.tf || '5m'}`;
          const clientState = clients.get(ws);
          if (clientState) clientState.tickers.delete(oldKey);
          const subs = subscriptions.get(oldKey);
          if (subs) subs.delete(ws);
        }
      } catch { /* ignore invalid messages */ }
    });

    ws.on('pong', () => {
      const state = clients.get(ws);
      if (state) state.alive = true;
    });

    ws.on('close', () => {
      cleanupClient(ws);
    });

    ws.on('error', () => {
      cleanupClient(ws);
    });
  });

  // Start heartbeat
  heartbeatTimer = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        cleanupClient(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Start polling loop
  startPolling();

  console.log(`[ws] WebSocket live feed attached (poll every ${POLL_INTERVAL_MS}ms)`);
}

function cleanupClient(ws) {
  const state = clients.get(ws);
  if (state) {
    for (const subKey of state.tickers) {
      const subs = subscriptions.get(subKey);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) subscriptions.delete(subKey);
      }
    }
  }
  clients.delete(ws);
}

/**
 * Send data to a WebSocket client with backpressure check.
 */
function safeSend(ws, data) {
  if (ws.readyState === 1 && ws.bufferedAmount < 1024 * 64) {
    ws.send(data);
  }
}

/**
 * Broadcast candle update to all subscribers of a ticker.
 */
function broadcast(ticker, tf, candle) {
  const subKey = `${ticker}:${tf}`;
  const subs = subscriptions.get(subKey);
  if (!subs || subs.size === 0) return;

  const msg = JSON.stringify({ type: 'candle', ticker, timeframe: tf, candle });
  for (const ws of subs) {
    safeSend(ws, msg);
  }
}

/**
 * Poll GPW API for all actively subscribed tickers and broadcast updates.
 */
async function pollAndBroadcast() {
  // Collect unique tickers from active subscriptions
  const tickerSet = new Set();
  for (const subKey of subscriptions.keys()) {
    const [ticker] = subKey.split(':');
    tickerSet.add(ticker);
  }

  if (tickerSet.size === 0) return;

  const tickers = [...tickerSet];

  // Use batch quote if available (single API call for many tickers)
  try {
    const quotes = await gpwProvider.fetchBatchQuotes(tickers);

    for (const [ticker, candle] of quotes) {
      if (!candle || !candle.close) continue;

      // Check if candle actually changed (skip redundant broadcasts)
      const prev = lastCandle.get(ticker);
      if (prev && prev.close === candle.close && prev.volume === candle.volume && prev.date === candle.date) {
        continue;
      }

      lastCandle.set(ticker, candle);

      // Broadcast to all timeframes this ticker is subscribed to
      for (const subKey of subscriptions.keys()) {
        const [t, tf] = subKey.split(':');
        if (t === ticker) {
          broadcast(ticker, tf, candle);
        }
      }
    }
  } catch (err) {
    console.warn(`[ws] Poll error: ${err.message}`);

    // Fallback: fetch individually for the first few tickers
    for (const ticker of tickers.slice(0, 5)) {
      try {
        const candle = await gpwProvider.fetchQuote(ticker);
        if (!candle) continue;
        lastCandle.set(ticker, candle);
        for (const subKey of subscriptions.keys()) {
          const [t, tf] = subKey.split(':');
          if (t === ticker) broadcast(ticker, tf, candle);
        }
      } catch { /* skip */ }
    }
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    pollAndBroadcast().catch(err => console.warn(`[ws] Poll cycle error: ${err.message}`));
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/**
 * Get live feed stats (for health/status endpoint).
 */
function getLiveStats() {
  return {
    clients: clients.size,
    subscriptions: subscriptions.size,
    activeTickers: new Set([...subscriptions.keys()].map(k => k.split(':')[0])).size,
    cachedCandles: lastCandle.size,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

module.exports = { attachWebSocket, getLiveStats, stopPolling, broadcast };

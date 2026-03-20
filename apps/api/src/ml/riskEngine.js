// ============================================================
// Risk Engine – Position sizing, stop-loss, and portfolio risk
//
// Implements:
// - Kelly criterion (fractional) position sizing
// - ATR-based stop-loss and take-profit levels
// - Portfolio-level risk limits (max drawdown, exposure)
// - Per-signal risk scoring
// ============================================================
const { query, queryOne, run, saveDb } = require('../db/connection');
const { getSector } = require('../data/sectors');

// Risk parameters (conservative defaults)
const RISK_CONFIG = {
  maxPortfolioExposure: 0.90,   // max 90% invested
  maxSinglePosition: 0.15,      // max 15% per position
  minSinglePosition: 0.02,      // min 2% per position
  kellyFraction: 0.25,          // quarter-Kelly for safety
  maxDrawdownLimit: 0.20,       // 20% max drawdown
  riskFreeRate: 0.0575,         // NBP reference rate ~5.75%
  stopLossATRMultiple: 2.0,     // SL at 2x ATR below entry
  takeProfitATRMultiple: 3.0,   // TP at 3x ATR above entry
  minConfidence: 0.10,          // min confidence to generate signal
  maxOpenPositions: 10,         // max distinct positions
  // --- Aggressive sell strategy (short-term) ---
  takeProfitFastPct: 0.04,     // +4% quick profit lock
  takeProfitFullPct: 0.08,     // +8% full target
  failSafeStopPct: 0.06,      // -6% max loss
  trailingStopPct: 0.03,      // 3% trailing from peak
  maxHoldSessions: 40,         // ~2 months max hold
  softTimeoutSessions: 15,     // 15 sessions without progress → exit signal
  // --- Futures-specific ---
  futuresMaxSinglePosition: 0.10,  // 10% max per futures contract
  futuresStopMultiple: 2.5,        // wider ATR stop for futures
  // --- Sector / concentration limits ---
  maxSectorExposure: 0.30,         // max 30% portfolio in one sector
  maxConcurrentSignals: 5,         // max signals published at once
};

// ============================================================
// POSITION SIZING
// ============================================================

/**
 * Calculate optimal position size for a signal.
 * Uses fractional Kelly criterion:
 *   kelly = (p * b - q) / b  where  p=winProb, b=winLossRatio, q=1-p
 * Then apply fraction and portfolio constraints.
 */
function calculatePositionSize(prediction, portfolioBalance) {
  if (!prediction || !portfolioBalance || portfolioBalance <= 0) return null;

  const { confidence, expectedReturn, scenarios } = prediction;

  // Estimate win probability and win/loss ratio from scenarios
  const winProb = Math.min(Math.max(0.5 + confidence / 2, 0.01), 0.99);
  const avgWin = Math.abs(scenarios.bull + scenarios.base) / 2;
  const avgLoss = Math.abs(scenarios.bear);
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

  // Kelly criterion
  const kellyRaw = (winProb * winLossRatio - (1 - winProb)) / winLossRatio;
  const kellyFrac = Math.max(kellyRaw * RISK_CONFIG.kellyFraction, 0);

  // Apply position limits
  let positionPct = Math.min(kellyFrac, RISK_CONFIG.maxSinglePosition);
  positionPct = Math.max(positionPct, confidence > RISK_CONFIG.minConfidence ? RISK_CONFIG.minSinglePosition : 0);

  // Scale down if expected return is negative
  if (expectedReturn < 0) positionPct = 0;

  const positionValue = portfolioBalance * positionPct;

  return {
    positionPct: r4(positionPct),
    positionValue: Math.floor(positionValue * 100) / 100,
    kellyRaw: r4(kellyRaw),
    kellyFractional: r4(kellyFrac),
    winProb: r4(winProb),
    winLossRatio: r4(winLossRatio),
  };
}

// ============================================================
// STOP-LOSS / TAKE-PROFIT
// ============================================================

/**
 * Calculate ATR-based stop-loss and take-profit levels.
 */
function calculateStopLevels(ticker, entryPrice) {
  if (!entryPrice || entryPrice <= 0) return null;

  // Get latest ATR from features
  const features = queryOne(
    'SELECT atr14 FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [ticker]
  );

  const atr = features?.atr14 || entryPrice * 0.02; // fallback: 2% of price

  const stopLoss = entryPrice - atr * RISK_CONFIG.stopLossATRMultiple;
  const takeProfit = entryPrice + atr * RISK_CONFIG.takeProfitATRMultiple;
  const riskRewardRatio = (takeProfit - entryPrice) / (entryPrice - stopLoss);

  return {
    entryPrice: r4(entryPrice),
    stopLoss: r4(Math.max(stopLoss, 0)),
    takeProfit: r4(takeProfit),
    atr: r4(atr),
    riskRewardRatio: r4(riskRewardRatio),
    maxLossPct: r4((entryPrice - stopLoss) / entryPrice * 100),
    maxGainPct: r4((takeProfit - entryPrice) / entryPrice * 100),
  };
}

// ============================================================
// PORTFOLIO RISK ASSESSMENT
// ============================================================

/**
 * Assess current portfolio risk: exposure, drawdown, concentration.
 */
function assessPortfolioRisk() {
  // Get current portfolio state
  const balance = queryOne("SELECT SUM(CASE WHEN type='deposit' THEN amount WHEN type='withdraw' THEN -amount ELSE 0 END) as cash FROM portfolio_transactions");
  const cash = balance?.cash || 0;

  const positions = query(`
    SELECT pt.ticker, 
      SUM(CASE WHEN pt.type = 'buy' THEN pt.shares ELSE -pt.shares END) as shares,
      AVG(CASE WHEN pt.type = 'buy' THEN pt.price END) as avg_cost
    FROM portfolio_transactions pt
    WHERE pt.type IN ('buy', 'sell')
    GROUP BY pt.ticker
    HAVING shares > 0
  `);

  let totalInvested = 0;
  let totalValue = 0;
  const positionRisks = [];

  for (const pos of positions) {
    // Get latest price (Stooq only)
    const latest = queryOne(
      'SELECT close FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [pos.ticker]
    );
    const currentPrice = latest?.close || pos.avg_cost;
    const value = pos.shares * currentPrice;
    const cost = pos.shares * pos.avg_cost;

    totalInvested += cost;
    totalValue += value;

    positionRisks.push({
      ticker: pos.ticker,
      shares: pos.shares,
      avgCost: r4(pos.avg_cost),
      currentPrice: r4(currentPrice),
      value: r4(value),
      pnlPct: r4((currentPrice / pos.avg_cost - 1) * 100),
      portfolioPct: 0, // filled below
    });
  }

  const portfolioTotal = cash + totalValue;
  const exposure = portfolioTotal > 0 ? totalValue / portfolioTotal : 0;

  // Fill portfolio percentages
  for (const pr of positionRisks) {
    pr.portfolioPct = portfolioTotal > 0 ? r4(pr.value / portfolioTotal * 100) : 0;
  }

  // Concentration risk (Herfindahl index)
  let herfindahl = 0;
  for (const pr of positionRisks) {
    const w = pr.value / (totalValue || 1);
    herfindahl += w * w;
  }

  // Max drawdown from peak
  const txHistory = query(`
    SELECT created_at as date, 
      SUM(CASE WHEN type='DEPOSIT' THEN amount WHEN type='WITHDRAW' THEN -amount ELSE 0 END) as cash_flow
    FROM portfolio_transactions
    GROUP BY created_at
    ORDER BY created_at
  `);

  return {
    cash: r4(cash),
    totalValue: r4(totalValue),
    portfolioTotal: r4(portfolioTotal),
    exposure: r4(exposure),
    exposureOk: exposure <= RISK_CONFIG.maxPortfolioExposure,
    positionCount: positions.length,
    maxPositionsOk: positions.length <= RISK_CONFIG.maxOpenPositions,
    concentration: r4(herfindahl),
    concentrationLevel: herfindahl > 0.3 ? 'HIGH' : herfindahl > 0.15 ? 'MEDIUM' : 'LOW',
    positions: positionRisks,
    limits: RISK_CONFIG,
  };
}

// ============================================================
// SIGNAL GENERATION
// ============================================================

/**
 * Generate trading signal from prediction + risk analysis.
 * Returns actionable signal with size, stops, and risk score.
 */
function generateSignal(prediction) {
  if (!prediction) return null;
  if (prediction.confidence < RISK_CONFIG.minConfidence) return null;

  const portfolio = assessPortfolioRisk();
  // Use real balance or a default simulation balance of 100,000 PLN
  const balance = portfolio.portfolioTotal > 0 ? portfolio.portfolioTotal : 100000;

  // Position sizing
  const sizing = calculatePositionSize(prediction, balance);
  if (!sizing || sizing.positionPct <= 0) return null;

  // Get current price for stop levels (Stooq only)
  const latest = queryOne(
    'SELECT close FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [prediction.ticker]
  );
  const entryPrice = latest?.close;
  const stops = entryPrice ? calculateStopLevels(prediction.ticker, entryPrice) : null;

  // Risk score 0-100 (lower = less risky)
  let riskScore = 50;
  riskScore -= prediction.confidence * 20;       // higher confidence reduces risk
  if (stops?.riskRewardRatio > 1.5) riskScore -= 10;
  if (stops?.riskRewardRatio < 1) riskScore += 15;
  if (portfolio.exposure > 0.7) riskScore += 15;  // already highly exposed
  if (prediction.regime === 'volatile') riskScore += 10;
  riskScore = Math.min(Math.max(Math.round(riskScore), 0), 100);

  // Hold duration estimate based on horizon and volatility
  const holdDays = prediction.horizonDays;
  const holdLabel = holdDays <= 5 ? 'Short-term (1 week)' :
                    holdDays <= 20 ? 'Medium-term (1 month)' : 'Long-term (3+ months)';

  const signal = {
    ticker: prediction.ticker,
    direction: prediction.direction,
    confidence: prediction.confidence,
    expectedReturnPct: prediction.expectedReturn,
    riskScore,
    riskLevel: riskScore > 60 ? 'HIGH' : riskScore > 35 ? 'MEDIUM' : 'LOW',
    sizing,
    stops,
    holdDays,
    holdLabel,
    scenarios: prediction.scenarios,
    regime: prediction.regime,
    modelVersion: prediction.modelVersion,
    generatedAt: new Date().toISOString(),
  };

  // Persist signal
  run(`INSERT INTO signals 
    (ticker, direction, confidence, expected_return, risk_score,
     position_size, stop_loss, take_profit, hold_days, model_version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [signal.ticker, signal.direction, signal.confidence,
     signal.expectedReturnPct, signal.riskScore,
     signal.sizing.positionPct, stops?.stopLoss, stops?.takeProfit,
     holdDays, signal.modelVersion]
  );

  // Audit log
  run(`INSERT INTO audit_log (event_type, entity, entity_id, payload)
       VALUES ('SIGNAL_GENERATED', 'signal', ?, ?)`,
    [signal.ticker, JSON.stringify({
      direction: signal.direction,
      confidence: signal.confidence,
      riskScore: signal.riskScore,
    })]
  );

  saveDb();
  return signal;
}

/**
 * Generate signals for top N predictions.
 * Enforces sector concentration and max concurrent signal limits.
 */
function generateAllSignals(predictions) {
  const signals = [];
  for (const pred of predictions) {
    const sig = generateSignal(pred);
    if (sig) signals.push(sig);
  }
  signals.sort((a, b) => {
    // Sort by: low risk score + high confidence + high return
    const scoreA = (100 - a.riskScore) * a.confidence * Math.abs(a.expectedReturnPct);
    const scoreB = (100 - b.riskScore) * b.confidence * Math.abs(b.expectedReturnPct);
    return scoreB - scoreA;
  });

  // Enforce sector limits and max concurrent signals
  const filtered = [];
  const sectorCount = {};
  for (const sig of signals) {
    if (filtered.length >= RISK_CONFIG.maxConcurrentSignals) break;
    const sector = getSector(sig.ticker);
    sectorCount[sector] = (sectorCount[sector] || 0);
    if (sectorCount[sector] >= 2) continue; // max 2 signals from same sector
    sectorCount[sector]++;
    filtered.push(sig);
  }

  console.log(`[risk] ${filtered.length} signals generated (${signals.length} raw, sector-filtered)`);
  return filtered;
}

function getLatestSignals(limit = 20) {
  return query(`
    SELECT s.*, i.name, i.type,
      (SELECT c.close FROM candles c WHERE c.ticker = s.ticker ORDER BY c.date DESC LIMIT 1) as lastClose
    FROM signals s
    JOIN instruments i ON i.ticker = s.ticker
    ORDER BY s.created_at DESC
    LIMIT ?
  `, [limit]);
}

// ============================================================
// HELPERS
// ============================================================
function r4(v) { return v != null ? Math.round(v * 10000) / 10000 : null; }

// ============================================================
// AGGRESSIVE SELL STRATEGY (short-term profit maximization)
// ============================================================

/**
 * Compute multi-layer sell levels for a position.
 * Returns: take_profit_fast, take_profit_full, fail_safe_stop,
 *          trailing_stop_trigger, suggested_sell_price, hold rules.
 */
function computeSellLevels(ticker, entryPrice) {
  if (!entryPrice || entryPrice <= 0) return null;

  const features = queryOne(
    'SELECT atr14, vol_20d, rsi14, macd_hist, regime FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [ticker]
  );
  const atr = features?.atr14 || entryPrice * 0.02;
  const vol = features?.vol_20d || 0.25;

  // Determine if this is a futures contract (wider thresholds)
  const inst = queryOne('SELECT type FROM instruments WHERE ticker = ?', [ticker]);
  const isFutures = inst?.type === 'FUTURES';

  // Scale TP/SL by volatility — higher vol = wider targets
  const volMultiplier = Math.max(0.7, Math.min(1.5, vol / 0.25));

  // --- Take-profit fast: quick lock at +4-6% (scaled by vol) ---
  const tpFastPct = RISK_CONFIG.takeProfitFastPct * volMultiplier;
  const takeProfitFast = entryPrice * (1 + tpFastPct);

  // --- Take-profit full: ambitious target at +8-12% ---
  const tpFullPct = RISK_CONFIG.takeProfitFullPct * volMultiplier;
  const takeProfitFull = entryPrice * (1 + tpFullPct);

  // --- Fail-safe stop: max allowed loss ---
  const failSafePct = isFutures
    ? RISK_CONFIG.failSafeStopPct * 1.3  // futures get wider stop
    : RISK_CONFIG.failSafeStopPct;
  const failSafeStop = entryPrice * (1 - failSafePct);

  // --- ATR-based stop (tighter, technical) ---
  const atrMultiple = isFutures ? RISK_CONFIG.futuresStopMultiple : RISK_CONFIG.stopLossATRMultiple;
  const atrStop = entryPrice - atr * atrMultiple;
  const stopLoss = Math.max(failSafeStop, atrStop); // use the tighter of the two

  // --- Trailing stop: kicks in after price moves +2% from entry ---
  const trailingActivation = entryPrice * 1.02;
  const trailingStopPct = RISK_CONFIG.trailingStopPct;

  // --- Suggested sell price for TODAY ---
  // Based on current signal strength: if momentum weakening → suggest fast TP
  let suggestedSellPrice = takeProfitFast;
  let sellUrgency = 'HOLD';
  if (features) {
    const momentumWeak = features.macd_hist < 0 && features.rsi14 > 65;
    const overbought = features.rsi14 > 75;
    if (overbought) {
      suggestedSellPrice = takeProfitFast * 0.99; // sell slightly below fast TP
      sellUrgency = 'SELL_NOW';
    } else if (momentumWeak) {
      suggestedSellPrice = takeProfitFast;
      sellUrgency = 'CONSIDER_SELL';
    } else {
      suggestedSellPrice = takeProfitFull; // hold for full target
      sellUrgency = 'HOLD';
    }
  }

  return {
    entryPrice: r4(entryPrice),
    takeProfitFast: r4(takeProfitFast),
    takeProfitFastPct: r4(tpFastPct * 100),
    takeProfitFull: r4(takeProfitFull),
    takeProfitFullPct: r4(tpFullPct * 100),
    stopLoss: r4(Math.max(stopLoss, 0)),
    failSafeStop: r4(Math.max(failSafeStop, 0)),
    failSafeStopPct: r4(failSafePct * 100),
    atrStop: r4(Math.max(atrStop, 0)),
    atr: r4(atr),
    trailingActivation: r4(trailingActivation),
    trailingStopPct: r4(trailingStopPct * 100),
    suggestedSellPrice: r4(suggestedSellPrice),
    sellUrgency,
    maxHoldSessions: RISK_CONFIG.maxHoldSessions,
    softTimeoutSessions: RISK_CONFIG.softTimeoutSessions,
    riskRewardFast: r4((takeProfitFast - entryPrice) / (entryPrice - stopLoss)),
    riskRewardFull: r4((takeProfitFull - entryPrice) / (entryPrice - stopLoss)),
  };
}

/**
 * Scan active positions and return sell candidates.
 * A position is a sell candidate if:
 *   - Price hit takeProfitFast or higher
 *   - Price dropped below stopLoss
 *   - Held too long (>maxHoldSessions)
 *   - Momentum degraded (RSI overbought + MACD divergence)
 */
function getSellCandidates() {
  // Get all current open positions from portfolio
  const positions = query(`
    SELECT pt.ticker,
      SUM(CASE WHEN pt.type = 'buy' THEN pt.shares ELSE -pt.shares END) as shares,
      AVG(CASE WHEN pt.type = 'buy' THEN pt.price END) as avg_cost,
      MIN(CASE WHEN pt.type = 'buy' THEN pt.created_at END) as first_buy
    FROM portfolio_transactions pt
    WHERE pt.type IN ('buy', 'sell')
    GROUP BY pt.ticker
    HAVING shares > 0
  `);

  const candidates = [];
  for (const pos of positions) {
    const latest = queryOne(
      'SELECT close, high, low, date FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [pos.ticker]
    );
    if (!latest) continue;

    const currentPrice = latest.close;
    const entryPrice = pos.avg_cost;
    const pnlPct = (currentPrice - entryPrice) / entryPrice * 100;

    // Compute sell levels from entry
    const sellLevels = computeSellLevels(pos.ticker, entryPrice);
    if (!sellLevels) continue;

    // Days held
    const daysHeld = pos.first_buy ? Math.floor((Date.now() - new Date(pos.first_buy).getTime()) / 86400000) : 0;

    // Determine sell reason
    const sellReasons = [];
    let action = 'HOLD';

    if (currentPrice >= sellLevels.takeProfitFull) {
      sellReasons.push('Osiągnięto pełny TP');
      action = 'SELL';
    } else if (currentPrice >= sellLevels.takeProfitFast) {
      sellReasons.push('Osiągnięto szybki TP – rozważ częściową sprzedaż');
      action = 'PARTIAL_SELL';
    }
    if (currentPrice <= sellLevels.stopLoss) {
      sellReasons.push('Poniżej stop-loss');
      action = 'SELL';
    }
    if (daysHeld >= RISK_CONFIG.maxHoldSessions) {
      sellReasons.push(`Przekroczono max hold (${daysHeld} dni)`);
      action = action === 'HOLD' ? 'SELL' : action;
    }
    if (daysHeld >= RISK_CONFIG.softTimeoutSessions && pnlPct < 1) {
      sellReasons.push(`Timeout ${daysHeld}D bez progresu`);
      action = action === 'HOLD' ? 'CONSIDER_SELL' : action;
    }

    // Check momentum degradation
    const features = queryOne(
      'SELECT rsi14, macd_hist, regime FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [pos.ticker]
    );
    if (features && features.rsi14 > 75 && features.macd_hist < 0) {
      sellReasons.push('Momentum osłabiony (RSI>75 + MACD<0)');
      if (action === 'HOLD') action = 'CONSIDER_SELL';
    }

    if (action !== 'HOLD') {
      candidates.push({
        ticker: pos.ticker,
        shares: pos.shares,
        entryPrice: r4(entryPrice),
        currentPrice: r4(currentPrice),
        pnlPct: r4(pnlPct),
        daysHeld,
        action,
        sellReasons,
        sellLevels,
      });
    }
  }

  candidates.sort((a, b) => {
    const priority = { SELL: 0, PARTIAL_SELL: 1, CONSIDER_SELL: 2 };
    return (priority[a.action] ?? 3) - (priority[b.action] ?? 3);
  });

  return candidates;
}

module.exports = {
  calculatePositionSize,
  calculateStopLevels,
  computeSellLevels,
  getSellCandidates,
  assessPortfolioRisk,
  generateSignal,
  generateAllSignals,
  getLatestSignals,
  RISK_CONFIG,
};

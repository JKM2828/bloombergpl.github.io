// ============================================================
// GPW Bloomberg AI v2.0 – Frontend Application
// ============================================================

const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001/api'
  : '/api';

const PROD_WS_ORIGIN = 'wss://bloomberpl-da6e13c64b4e.herokuapp.com';

// ---- Navigation ----
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');

    // Load data for view
    switch (btn.dataset.view) {
      case 'dashboard': loadDashboard(); break;
      case 'today': loadToday(); break;
      case 'predictions': loadPredictions(); break;
      case 'signals': loadSignals(); break;
      case 'screener': loadScreener(); break;
      case 'chart': loadChartTickers(); break;
      case 'portfolio': loadPortfolio(); break;
      case 'risk': loadRisk(); break;
      case 'worker': loadWorker(); break;
      case 'health': loadHealth(); break;
    }
  });
});

// ============================================================
// API Helpers
// ============================================================
async function api(path, options = {}) {
  try {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  } catch (err) {
    console.error(`API ${path}:`, err);
    throw err;
  }
}

function pnlClass(val) { return val > 0 ? 'positive' : val < 0 ? 'negative' : ''; }
function fmt(v, d = 2) { return v != null ? Number(v).toFixed(d) : '—'; }
function dirBadge(dir) {
  const cls = dir === 'BUY' ? 'badge-buy' : dir === 'SELL' ? 'badge-sell' : 'badge-hold';
  const label = dir === 'BUY' ? 'KUP' : dir === 'SELL' ? 'SPRZEDAJ' : 'TRZYMAJ';
  return `<span class="badge ${cls}">${label}</span>`;
}
function riskBadge(level) {
  const cls = level === 'LOW' ? 'badge-low' : level === 'MEDIUM' ? 'badge-medium' : 'badge-high';
  return `<span class="badge ${cls}">${level}</span>`;
}

// ============================================================
// SYGNAŁY DNIA – Co kupić / sprzedać
// ============================================================
async function loadToday() {
  try {
    const data = await api('/today?limit=50');
    const buyActions = data.actions.filter(a => a.action === 'KUP');
    const sellActions = data.actions.filter(a => a.action !== 'KUP');

    document.getElementById('today-buy-count').textContent = buyActions.length;
    document.getElementById('today-sell-count').textContent = sellActions.length;
    document.getElementById('today-regime').textContent = data.regime || '—';

    const tbody = document.querySelector('#today-table tbody');
    if (data.actions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Brak sygnałów. Uruchom pipeline ML aby wygenerować predykcje.</td></tr>';
      return;
    }

    tbody.innerHTML = data.actions.map(a => {
      const actionCls = a.action === 'KUP' ? 'badge-buy' : (a.action === 'TRZYMAJ' ? 'badge-hold' : 'badge-sell');
      return `<tr>
        <td><strong>${a.ticker}</strong></td>
        <td>${a.name || '—'}</td>
        <td>${a.type || '—'}</td>
        <td>${a.price != null ? fmt(a.price) : '—'}</td>
        <td><span class="badge ${actionCls}">${a.action}</span></td>
        <td>${a.confidence != null ? fmt(a.confidence, 1) + '%' : '—'}</td>
        <td class="${pnlClass(a.expectedReturn)}">${a.expectedReturn != null ? fmt(a.expectedReturn, 2) + '%' : '—'}</td>
        <td>${a.rsi != null ? fmt(a.rsi, 1) : '—'}</td>
        <td style="font-size:0.8em;max-width:300px">${a.reason || '—'}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    document.querySelector('#today-table tbody').innerHTML =
      `<tr><td colspan="9" style="color:var(--red)">${err.message}</td></tr>`;
  }
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  loadInstrumentsTable();
  loadTop5();
  loadLiveSignals();
  loadSystemStatus();
  loadDashPrediction();
  loadDashSignal();
  loadDashWorker();
}

async function loadLiveSignals() {
  try {
    const picksData = await api('/picks/daily?limit=5');
    if (picksData && picksData.picks && picksData.picks.length > 0) {
      const el = document.getElementById('live-signals');
      const gates = picksData.qualityGates || {};
      const dataAgeSec = picksData.dataAgeSec || 0;
      const dataAgeMin = Math.round(dataAgeSec / 60);
      const staleWarning = dataAgeSec > 3600
        ? `<div style="background:var(--red);color:#fff;padding:6px 12px;border-radius:6px;margin-bottom:8px;font-size:0.85em">⚠ Dane sprzed ${dataAgeMin} min — ranking może być nieaktualny</div>`
        : dataAgeSec > 1800
          ? `<div style="background:var(--yellow);color:#000;padding:6px 12px;border-radius:6px;margin-bottom:8px;font-size:0.85em">⏳ Dane sprzed ${dataAgeMin} min</div>`
          : '';
      el.innerHTML = `
        ${staleWarning}
        <div style="font-size:0.75em;color:var(--text-muted);margin-bottom:8px">
          Reżim: <strong>${picksData.regime}</strong> |
          Przeskanowano: ${picksData.totalScreened || '—'} |
          Przeszło filtry: ${picksData.passedGates || '—'} |
          Min pewność: ${(gates.minConfidence || 0) * 100}% |
          <span style="font-size:0.9em">${picksData.generatedAt || ''}</span>
          ${dataAgeMin > 0 ? `| <strong>${dataAgeMin} min temu</strong>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px">
          ${picksData.picks.map(p => `
            <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <strong style="font-size:1.1em">${p.ticker}</strong>
                <span class="badge badge-buy">EDGE ${p.edgeScore || '—'}</span>
              </div>
              <div style="font-size:0.85em;color:var(--text-muted)">${p.name || ''} · ${p.sector || ''}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px;font-size:0.85em">
                <div>Score: <strong>${fmt(p.compositeScore)}</strong></div>
                <div>ML: <strong class="positive">${p.ml ? p.ml.confidence + '%' : '—'}</strong></div>
                <div>Oczek. zwrot: <strong class="${pnlClass(p.ml?.expectedReturn)}">${p.ml ? p.ml.expectedReturn + '%' : '—'}</strong></div>
                <div>RS: <strong class="${pnlClass(p.relativeStrength)}">${fmt(p.relativeStrength)}%</strong></div>
              </div>
              ${p.sell ? `
                <div style="font-size:0.8em;margin-top:4px;padding-top:4px;border-top:1px solid var(--border)">
                  SL: <span class="negative">${fmt(p.sell.stopLoss)}</span> |
                  TP1: <span class="positive">${fmt(p.sell.takeProfitFast)}</span> |
                  TP2: <span class="positive">${fmt(p.sell.takeProfitFull)}</span>
                </div>` : ''}
              <div style="font-size:0.75em;color:var(--text-muted);margin-top:4px">${p.growth ? `D: ${p.growth.dailyGrowthPct}% | W: ${p.growth.weeklyGrowthPct}% | M: ${p.growth.monthlyGrowthPct}%` : ''}</div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      document.getElementById('live-signals').innerHTML =
        '<p style="color:var(--text-muted)">Brak sygnałów po filtracji quality gates. Uruchom pełny pipeline.</p>';
    }
  } catch {
    document.getElementById('live-signals').innerHTML =
      '<p style="color:var(--text-muted)">Nie można załadować sygnałów.</p>';
  }
}

async function loadTop5() {
  try {
    const data = await api('/ranking?limit=100');
    const ranking = data.ranking || [];
    const rankedAt = data.rankedAt;

    const top5El = document.getElementById('top5-list');
    const bottom5El = document.getElementById('bottom5-list');
    const tsEl = document.getElementById('ranking-timestamp');

    if (ranking.length === 0) {
      top5El.innerHTML = '<p style="color:var(--text-muted)">Brak danych rankingu. Uruchom ingest i screener.</p>';
      bottom5El.innerHTML = top5El.innerHTML;
      if (tsEl) tsEl.textContent = '';
      return;
    }

    if (tsEl && rankedAt) {
      const ageMin = data.dataAgeSec ? Math.round(data.dataAgeSec / 60) : 0;
      const ageLabel = ageMin > 60 ? ` (⚠ ${ageMin} min temu)` : ageMin > 0 ? ` (${ageMin} min temu)` : '';
      tsEl.textContent = `Ranking z: ${rankedAt}${ageLabel}`;
      tsEl.style.color = ageMin > 60 ? 'var(--red)' : '';
    }

    const top5 = ranking.slice(0, 5);
    const bottom5 = ranking.slice(-5).reverse();

    top5El.innerHTML = top5.map((r, i) => `
      <div class="rank-item">
        <span>
          <span class="ticker">${i + 1}. ${r.ticker}</span> ${r.name}
          ${(r.lastClose ?? r.metrics?.lastClose) != null ? `<span style="color:var(--text-muted);font-size:0.85em;margin-left:6px">${fmt(r.lastClose ?? r.metrics?.lastClose)} PLN</span>` : ''}
        </span>
        <span class="score positive" title="Score 0-100">${fmt(r.score)} <small style="opacity:0.6">pkt</small></span>
      </div>
    `).join('');

    bottom5El.innerHTML = bottom5.map((r, i) => `
      <div class="rank-item">
        <span>
          <span class="ticker">${r.ticker}</span> ${r.name}
          ${(r.lastClose ?? r.metrics?.lastClose) != null ? `<span style="color:var(--text-muted);font-size:0.85em;margin-left:6px">${fmt(r.lastClose ?? r.metrics?.lastClose)} PLN</span>` : ''}
        </span>
        <span class="score negative" title="Score 0-100">${fmt(r.score)} <small style="opacity:0.6">pkt</small></span>
      </div>
    `).join('');
  } catch {
    document.getElementById('top5-list').innerHTML = '<p style="color:var(--text-muted)">Brak danych. Uruchom ingest.</p>';
    document.getElementById('bottom5-list').innerHTML = '<p style="color:var(--text-muted)">Brak danych. Uruchom ingest.</p>';
  }
}

async function loadSystemStatus() {
  try {
    const [data, freshness] = await Promise.all([
      api('/health'),
      api('/freshness').catch(() => null),
    ]);
    const statusColor = data.status === 'ok' ? 'var(--green)' : data.status === 'degraded' ? 'var(--yellow)' : 'var(--red)';
    const stooq = (data.providers || []).find((p) => p.provider === 'stooq' || p.provider === 'stooq-json');
    const allDown = (data.providers || []).every(p => !p.ok);
    const limitHint = allDown ? '<p style="color:var(--yellow)">Uwaga: Wszystkie źródła danych chwilowo niedostępne – dashboard pokazuje dane z bazy.</p>' : '';
    const freshnessLine = freshness
      ? `<p>Świeżość: <strong>${freshness.fresh}/${freshness.total}</strong> świeżych, <strong>${freshness.stale}</strong> oczekuje na ingest</p>`
      : '';
    document.getElementById('system-status').innerHTML = `
      <div style="font-size:0.9em">
        <p>Status: <strong style="color:${statusColor}">${data.status.toUpperCase()}</strong></p>
        <p>Instrumenty: <strong>${data.instruments}</strong></p>
        <p>Świece w bazie: <strong>${data.candles.toLocaleString()}</strong></p>
        <p>Ostatni ingest: <strong>${data.lastIngest || 'brak'}</strong></p>
        ${freshnessLine}
        ${limitHint}
        <p>Providery:</p>
        ${data.providers.map(p => `
          <p style="margin-left:12px">
            <span class="status-dot ${p.ok ? 'status-ok' : 'status-err'}"></span> ${p.provider} ${p.candles ? `(${p.candles} świec)` : ''}
            ${p.error ? `<span style="color:var(--red)">${p.error}</span>` : ''}
          </p>
        `).join('')}
      </div>
    `;
  } catch {
    document.getElementById('system-status').textContent = 'Nie można połączyć z API';
  }
}

async function loadDashPrediction() {
  try {
    const data = await api('/predictions?limit=1');
    const pred = (data.predictions || [])[0];
    if (!pred) {
      document.getElementById('dash-top-prediction').innerHTML =
        '<p style="color:var(--text-muted)">Brak predykcji. Uruchom pipeline ML.</p>';
      return;
    }
    document.getElementById('dash-top-prediction').innerHTML = `
      <div style="font-size:0.9em">
        <p><strong>${pred.ticker}</strong> ${pred.name || ''}</p>
        <p>${dirBadge(pred.predicted_direction)} Pewność: <strong>${fmt(pred.confidence * 100)}%</strong></p>
        <p>Oczekiwany zwrot: <strong class="${pnlClass(pred.predicted_return)}">${fmt(pred.predicted_return * 100)}%</strong></p>
        <div class="scenario-bar">
          <span class="positive">Bull ${fmt(pred.scenario_bull * 100)}%</span>
          <span>Base ${fmt(pred.scenario_base * 100)}%</span>
          <span class="negative">Bear ${fmt(pred.scenario_bear * 100)}%</span>
        </div>
      </div>
    `;
  } catch { /* ignore */ }
}

async function loadDashSignal() {
  try {
    const data = await api('/signals?limit=1');
    const sig = (data.signals || [])[0];
    if (!sig) {
      document.getElementById('dash-top-signal').innerHTML =
        '<p style="color:var(--text-muted)">Brak sygnałów.</p>';
      return;
    }
    document.getElementById('dash-top-signal').innerHTML = `
      <div style="font-size:0.9em">
        <p><strong>${sig.ticker}</strong> ${sig.name || ''}</p>
        <p>${dirBadge(sig.direction)}</p>
        <p>Ryzyko: ${riskBadge(sig.risk_score > 60 ? 'HIGH' : sig.risk_score > 35 ? 'MEDIUM' : 'LOW')} (${sig.risk_score}/100)</p>
        <p>SL: <span class="negative">${fmt(sig.stop_loss)}</span> | TP: <span class="positive">${fmt(sig.take_profit)}</span></p>
      </div>
    `;
  } catch { /* ignore */ }
}

async function loadDashWorker() {
  try {
    const data = await api('/worker/status');
    document.getElementById('dash-worker-status').innerHTML = `
      <div style="font-size:0.9em">
        <p>Status: <strong style="color:${data.isRunning ? 'var(--green)' : 'var(--red)'}">${data.isRunning ? 'Aktywny' : 'Zatrzymany'}</strong></p>
        <p>Kolejka: <strong>${data.queueSize}</strong> zadań</p>
        <p>Przetworzono: <strong>${data.jobsProcessed}</strong></p>
      </div>
    `;
  } catch { /* ignore */ }
}

let allInstruments = [];
async function loadInstrumentsTable(type = '') {
  try {
    const url = type ? `/instruments?type=${type}` : '/instruments';
    const data = await api(url);
    allInstruments = data;
    renderInstrumentsTable(data);
  } catch {
    document.querySelector('#instruments-table tbody').innerHTML =
      '<tr><td colspan="5">Nie można załadować instrumentów</td></tr>';
  }
}

function renderInstrumentsTable(instruments) {
  const tbody = document.querySelector('#instruments-table tbody');
  tbody.innerHTML = instruments.map((inst) => `
    <tr>
      <td><strong>${inst.ticker}</strong></td>
      <td>${inst.name}</td>
      <td>${inst.sector || '—'}</td>
      <td><span class="filter-btn" style="pointer-events:none;padding:2px 8px;font-size:0.8em">${inst.type}</span></td>
      <td><strong>${inst.lastClose != null ? fmt(inst.lastClose) + ' <span style="color:var(--text-muted);font-size:0.85em">PLN</span>' : '—'}</strong></td>
      <td>
        <button class="btn-sm" onclick="showChart('${inst.ticker}')">Chart</button>
        <button class="btn-sm" onclick="showPrediction('${inst.ticker}')">AI</button>
      </td>
    </tr>
  `).join('');
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadInstrumentsTable(btn.dataset.type);
  });
});

// ============================================================
// PREDICTIONS
// ============================================================
async function loadPredictions() {
  try {
    const data = await api('/predictions?limit=50');
    const predictions = data.predictions || [];
    const tbody = document.querySelector('#predictions-table tbody');

    if (predictions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="16">Brak predykcji. Uruchom pipeline: Ingest → Features → Predykcje.</td></tr>';
      document.getElementById('prediction-summary').innerHTML = '';
      return;
    }

    // Summary cards
    const buys = predictions.filter(p => p.predicted_direction === 'BUY');
    const sells = predictions.filter(p => p.predicted_direction === 'SELL');
    const avgConf = predictions.reduce((s, p) => s + (p.confidence || 0), 0) / predictions.length;

    document.getElementById('prediction-summary').innerHTML = `
      <div class="indicator-card ai-card">
        <div class="label">Sygnały KUP</div>
        <div class="value positive">${buys.length}</div>
      </div>
      <div class="indicator-card ai-card">
        <div class="label">Sygnały SPRZEDAJ</div>
        <div class="value negative">${sells.length}</div>
      </div>
      <div class="indicator-card ai-card">
        <div class="label">Śr. pewność modelu</div>
        <div class="value">${fmt(avgConf * 100)}%</div>
      </div>
    `;

    tbody.innerHTML = predictions.map((p, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${p.ticker}</strong> <span style="color:var(--text-muted);font-size:0.75em">${p.type || ''}</span></td>
        <td>${p.name || ''}</td>
        <td><strong>${p.lastClose != null ? fmt(p.lastClose) + ' <span style="color:var(--text-muted);font-size:0.8em">PLN</span>' : '—'}</strong></td>
        <td>${dirBadge(p.predicted_direction)}</td>
        <td>${fmt(p.confidence * 100)}%</td>
        <td class="${pnlClass(p.predicted_return)}"><strong>${fmt(p.predicted_return * 100)}%</strong></td>
        <td class="positive">${fmt(p.scenario_bull * 100)}%</td>
        <td>${fmt(p.scenario_base * 100)}%</td>
        <td class="negative">${fmt(p.scenario_bear * 100)}%</td>
        <td class="positive"><strong>${p.targetPriceBull != null ? fmt(p.targetPriceBull) + ' PLN' : '—'}</strong></td>
        <td><strong>${p.targetPriceBase != null ? fmt(p.targetPriceBase) + ' PLN' : '—'}</strong></td>
        <td class="negative"><strong>${p.targetPriceBear != null ? fmt(p.targetPriceBear) + ' PLN' : '—'}</strong></td>
        <td>${fmt(p.rsi || null)}</td>
        <td class="${pnlClass(p.macd_hist)}">${fmt(p.macd_hist || null, 3)}</td>
        <td>${p.regime || '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    document.querySelector('#predictions-table tbody').innerHTML =
      `<tr><td colspan="16" class="negative">Błąd: ${err.message}</td></tr>`;  }
}

function showPrediction(ticker) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelector('[data-view="predictions"]').classList.add('active');
  document.getElementById('view-predictions').classList.add('active');
  loadPredictions();
}

// Prediction action buttons
document.getElementById('btn-run-pipeline').addEventListener('click', async () => {
  const el = document.getElementById('prediction-status');
  el.innerHTML = '<span style="color:var(--yellow)">Uruchamiam pełny pipeline...</span>';
  try {
    const data = await api('/pipeline/run', { method: 'POST' });
    el.innerHTML = `<span style="color:var(--green)">Pipeline gotowy! ${data.jobsProcessed} zadań przetworzonych.</span>`;
    loadPredictions();
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red)">Błąd: ${err.message}</span>`;
  }
});

document.getElementById('btn-run-predictions').addEventListener('click', async () => {
  const el = document.getElementById('prediction-status');
  el.innerHTML = '<span style="color:var(--yellow)">Generuję predykcje...</span>';
  try {
    const data = await api('/predictions/run', { method: 'POST' });
    el.innerHTML = `<span style="color:var(--green)">${data.predictionsCount} predykcji, ${data.signalsCount} sygnałów.</span>`;
    loadPredictions();
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red)">${err.message}</span>`;
  }
});

document.getElementById('btn-train-models').addEventListener('click', async () => {
  const el = document.getElementById('prediction-status');
  el.innerHTML = '<span style="color:var(--yellow)">Trenuję modele neuronowe... to może potrwać.</span>';
  try {
    const data = await api('/ml/train', { method: 'POST' });
    el.innerHTML = `<span style="color:var(--green)">Wytrenowano ${data.models} modeli.</span>`;
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red)">${err.message}</span>`;
  }
});

// ============================================================
// SIGNALS
// ============================================================
async function loadSignals() {
  try {
    const data = await api('/signals?limit=50');
    const signals = data.signals || [];
    const tbody = document.querySelector('#signals-table tbody');

    if (signals.length === 0) {
      tbody.innerHTML = '<tr><td colspan="13">Brak sygnałów. Uruchom pipeline predykcji.</td></tr>';
      return;
    }

    tbody.innerHTML = signals.map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${s.ticker}</strong> <span style="color:var(--text-muted);font-size:0.8em">${s.name || ''}</span></td>
        <td><strong>${s.lastClose != null ? fmt(s.lastClose) + ' <span style="color:var(--text-muted);font-size:0.8em">PLN</span>' : '—'}</strong></td>
        <td>${dirBadge(s.direction)}</td>
        <td>${fmt(s.confidence * 100)}%</td>
        <td class="${pnlClass(s.expected_return)}"><strong>${fmt(s.expected_return * 100)}%</strong></td>
        <td>${riskBadge(s.risk_score > 60 ? 'HIGH' : s.risk_score > 35 ? 'MEDIUM' : 'LOW')} ${s.risk_score}</td>
        <td>${fmt(s.position_size * 100)}%</td>
        <td class="negative">${fmt(s.stop_loss)}</td>
        <td class="positive">${fmt(s.take_profit)}</td>
        <td>${s.hold_days || '—'} dni</td>
        <td style="font-size:0.75em">${s.model_version || '—'}</td>
        <td style="font-size:0.75em">${s.created_at || ''}</td>
      </tr>
    `).join('');
  } catch (err) {
    document.querySelector('#signals-table tbody').innerHTML =
      `<tr><td colspan="13" class="negative">Błąd: ${err.message}</td></tr>`;
  }
}

// ============================================================
// SCREENER
// ============================================================
async function loadScreener() {
  try {
    const data = await api('/ranking?limit=100');
    const ranking = data.ranking || [];
    const tbody = document.querySelector('#ranking-table tbody');

    if (ranking.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12">Brak danych. Uruchom ingest i kliknij "Przelicz ranking".</td></tr>';
      return;
    }

    tbody.innerHTML = ranking.map((r, i) => {
      const m = r.metrics || {};
      const price = r.lastClose ?? m.lastClose;
      return `
        <tr>
          <td>${i + 1}</td>
          <td><strong>${r.ticker}</strong></td>
          <td>${r.name}</td>
          <td>${r.type}</td>
          <td><strong>${price != null ? fmt(price) + ' <span style="color:var(--text-muted);font-size:0.8em">PLN</span>' : '—'}</strong></td>
          <td><strong class="${pnlClass(r.score - 50)}">${fmt(r.score)}</strong></td>
          <td class="${pnlClass(m.perf1M)}">${fmt(m.perf1M)}%</td>
          <td class="${pnlClass(m.perf3M)}">${fmt(m.perf3M)}%</td>
          <td>${fmt(m.rsi)}</td>
          <td>${fmt(m.volatility)}%</td>
          <td class="negative">${fmt(m.maxDrawdown)}%</td>
          <td style="font-size:0.85em">${r.reason || '—'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    document.querySelector('#ranking-table tbody').innerHTML =
      `<tr><td colspan="12">Błąd: ${err.message}</td></tr>`;
  }
}

document.getElementById('btn-run-screener').addEventListener('click', async () => {
  const statusEl = document.getElementById('screener-status');
  statusEl.textContent = 'Obliczam ranking...';
  try {
    const data = await api('/ranking/run', { method: 'POST' });
    statusEl.textContent = `Ranking gotowy – ${data.count} instrumentów`;
    loadScreener();
  } catch (err) {
    statusEl.textContent = `Błąd: ${err.message}`;
  }
});

// ============================================================
// CHART (with TradingView toggle)
// ============================================================
let chart = null;
let candleSeries = null;
let sma20Series = null;
let sma50Series = null;
let volumeSeries = null;

// ---- WebSocket Live Feed ----
let wsChart = null;
let wsReconnectTimer = null;
const WS_RECONNECT_DELAY_MS = 5000;

function getWsUrl() {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'ws://localhost:3001';
  }
  return PROD_WS_ORIGIN;
}

function updateLiveStatus(state) {
  const el = document.getElementById('chart-live-status');
  if (!el) return;
  const colors = { connected: 'var(--green)', reconnecting: 'var(--yellow)', disconnected: 'var(--red)', off: 'var(--text-muted)' };
  const labels = { connected: 'LIVE', reconnecting: 'Reconnecting...', disconnected: 'Offline', off: '' };
  el.innerHTML = state === 'off' ? '' : `<span style="color:${colors[state]}; font-weight:600">\u25cf ${labels[state]}</span>`;
}

function connectChartWS(ticker, tf) {
  disconnectChartWS();
  if (!ticker || (tf !== '5m' && tf !== '1h')) {
    updateLiveStatus('off');
    return;
  }

  const url = `${getWsUrl()}/ws/live?ticker=${encodeURIComponent(ticker)}&tf=${encodeURIComponent(tf)}`;
  updateLiveStatus('reconnecting');

  try {
    wsChart = new WebSocket(url);
  } catch {
    updateLiveStatus('disconnected');
    scheduleReconnect(ticker, tf);
    return;
  }

  wsChart.onopen = () => {
    updateLiveStatus('connected');
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  };

  wsChart.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'candle' && msg.candle && candleSeries) {
        const c = msg.candle;
        const point = { time: c.date, open: c.open, high: c.high, low: c.low, close: c.close };
        candleSeries.update(point);
        if (volumeSeries) {
          volumeSeries.update({ time: c.date, value: c.volume || 0, color: c.close >= c.open ? '#3fb95044' : '#f8514944' });
        }
      }
    } catch { /* ignore */ }
  };

  wsChart.onclose = () => {
    updateLiveStatus('disconnected');
    scheduleReconnect(ticker, tf);
  };

  wsChart.onerror = () => {
    updateLiveStatus('disconnected');
  };
}

function disconnectChartWS() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (wsChart) {
    wsChart.onclose = null;
    wsChart.onerror = null;
    wsChart.close();
    wsChart = null;
  }
  updateLiveStatus('off');
}

function scheduleReconnect(ticker, tf) {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    // Only reconnect if still on chart view and same ticker
    const activeView = document.querySelector('.view.active');
    const currentTicker = document.getElementById('chart-ticker').value;
    const currentTf = document.getElementById('chart-timeframe').value;
    if (activeView?.id === 'view-chart' && currentTicker === ticker && currentTf === tf) {
      connectChartWS(ticker, tf);
    }
  }, WS_RECONNECT_DELAY_MS);
}

async function loadChartTickers() {
  try {
    const data = await api('/instruments');
    const select = document.getElementById('chart-ticker');
    select.innerHTML = data.map((i) => `<option value="${i.ticker}">${i.ticker} – ${i.name}</option>`).join('');

    const tradeSelect = document.getElementById('trade-ticker');
    if (tradeSelect) {
      tradeSelect.innerHTML = data
        .filter((i) => i.type === 'STOCK' || i.type === 'ETF')
        .map((i) => `<option value="${i.ticker}">${i.ticker}</option>`).join('');
    }
  } catch { /* ignore */ }
}

function showChart(ticker) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelector('[data-view="chart"]').classList.add('active');
  document.getElementById('view-chart').classList.add('active');
  loadChartTickers().then(() => {
    document.getElementById('chart-ticker').value = ticker;
    loadChart(ticker);
  });
}

document.getElementById('btn-load-chart').addEventListener('click', () => {
  const ticker = document.getElementById('chart-ticker').value;
  if (ticker) loadChart(ticker);
});

// Timeframe change also reloads chart
document.getElementById('chart-timeframe').addEventListener('change', () => {
  const ticker = document.getElementById('chart-ticker').value;
  if (ticker) loadChart(ticker);
});

// Auto-refresh logic
let chartAutoRefreshTimer = null;
document.getElementById('chart-auto-refresh').addEventListener('change', (e) => {
  if (chartAutoRefreshTimer) { clearInterval(chartAutoRefreshTimer); chartAutoRefreshTimer = null; }
  if (e.target.checked) {
    const tf = document.getElementById('chart-timeframe').value;
    const intervalMs = tf === '5m' ? 30 * 1000 : tf === '1h' ? 5 * 60 * 1000 : 60 * 60 * 1000; // 30s for 5m, 5min for 1h, 60min for 1d
    chartAutoRefreshTimer = setInterval(() => {
      const ticker = document.getElementById('chart-ticker').value;
      if (ticker) loadChart(ticker);
    }, intervalMs);
  }
});

// TradingView removed – single data source: Stooq API via backend
// All chart data comes exclusively from /api/candles/:ticker

async function loadChart(ticker) {
  const tf = document.getElementById('chart-timeframe').value || '1d';
  try {
    const data = await api(`/candles/${ticker}?timeframe=${tf}`);
    // Show freshness info
    const freshEl = document.getElementById('chart-freshness');
    if (freshEl && data.lastDate) {
      const now = new Date();
      const last = new Date(data.lastDate);
      const diffH = Math.round((now - last) / 3600000);
      // Market-aware: stale only if >2 business days behind
      const dow = now.getDay(); // 0=Sun, 6=Sat
      const staleThresholdH = tf === '5m' ? 1 : (dow === 0 || dow === 6) ? 96 : 72;
      const stale = diffH > staleThresholdH;
      const tfLabel = tf === '5m' ? '5M Live' : tf === '1h' ? '1H' : 'EOD';
      freshEl.innerHTML = `<i data-lucide="${stale ? 'alert-triangle' : 'clock'}" class="icon-inline"></i> ` +
        `Dane: ${data.lastDate} | ${tfLabel} | Provider: ${data.provider || 'gpw'} | ` +
        (stale ? `<span style="color:var(--red)">Stale (${diffH}h)</span>` : `<span style="color:var(--green)">${diffH}h</span>`);
      if (window.lucide) lucide.createIcons();
    }
    renderChart(data, tf);
    loadChartPrediction(ticker);

    // Activate WebSocket live feed for intraday timeframes
    if (tf === '5m' || tf === '1h') {
      connectChartWS(ticker, tf);
    } else {
      disconnectChartWS();
    }
  } catch (err) {
    disconnectChartWS();
    document.getElementById('chart-container').innerHTML =
      `<p style="padding:40px;color:var(--red)">Brak danych dla ${ticker} (${tf}). Uruchom ingest.</p>`;
    document.getElementById('chart-indicators').innerHTML = '';
    const freshEl = document.getElementById('chart-freshness');
    if (freshEl) freshEl.textContent = 'Brak danych';
  }
}

async function loadChartPrediction(ticker) {
  try {
    const data = await api(`/predictions/${ticker}`);
    const p = data.prediction;
    document.getElementById('chart-pred-content').innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
        <div>
          <strong>Kierunek:</strong> ${dirBadge(p.predicted_direction)}<br>
          <strong>Pewność:</strong> ${fmt(p.confidence * 100)}%<br>
          <strong>Oczekiwany zwrot:</strong> <span class="${pnlClass(p.predicted_return)}">${fmt(p.predicted_return * 100)}%</span>
        </div>
        <div>
          <strong>Scenariusze (${p.horizon_days} dni):</strong><br>
          Bull: <span class="positive">${fmt(p.scenario_bull * 100)}%</span><br>
          Base: ${fmt(p.scenario_base * 100)}%<br>
          Bear: <span class="negative">${fmt(p.scenario_bear * 100)}%</span>
        </div>
        <div>
          <strong>Model:</strong> ${p.model_version || '—'}<br>
          <strong>Data:</strong> ${p.prediction_date || p.created_at || '—'}
        </div>
      </div>
    `;
  } catch {
    document.getElementById('chart-pred-content').innerHTML =
      '<p style="color:var(--text-muted)">Brak predykcji dla tego instrumentu. Uruchom pipeline ML.</p>';
  }
}

function renderChart(data, tf) {
  const container = document.getElementById('chart-container');
  container.innerHTML = '';

  const timeVisible = tf === '1h';
  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 500,
    layout: {
      background: { type: 'solid', color: '#161b22' },
      textColor: '#8b949e',
    },
    grid: {
      vertLines: { color: '#30363d' },
      horzLines: { color: '#30363d' },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: { timeVisible, borderColor: '#30363d' },
    rightPriceScale: { borderColor: '#30363d' },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149',
    borderUpColor: '#3fb950', borderDownColor: '#f85149',
    wickUpColor: '#3fb950', wickDownColor: '#f85149',
  });

  const chartData = data.candles.map((c) => ({
    time: c.date, open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  candleSeries.setData(chartData);

  if (data.candles.length >= 20) {
    sma20Series = chart.addLineSeries({ color: '#58a6ff', lineWidth: 1, title: 'SMA20' });
    sma20Series.setData(computeSMA(data.candles, 20));
  }
  if (data.candles.length >= 50) {
    sma50Series = chart.addLineSeries({ color: '#d29922', lineWidth: 1, title: 'SMA50' });
    sma50Series.setData(computeSMA(data.candles, 50));
  }

  volumeSeries = chart.addHistogramSeries({
    color: '#58a6ff44', priceFormat: { type: 'volume' }, priceScaleId: '',
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  volumeSeries.setData(data.candles.map((c) => ({
    time: c.date, value: c.volume,
    color: c.close >= c.open ? '#3fb95044' : '#f8514944',
  })));

  chart.timeScale().fitContent();
  window.addEventListener('resize', () => { chart.applyOptions({ width: container.clientWidth }); });

  // Pivot levels as horizontal price lines (if available in indicators)
  const ind = data.indicators || {};
  if (ind.pivot_pp && candleSeries) {
    const pivotLines = [
      { price: ind.pivot_r2, color: '#f8514966', title: 'R2', style: 2 },
      { price: ind.pivot_r1, color: '#f8514988', title: 'R1', style: 2 },
      { price: ind.pivot_pp, color: '#8b949e', title: 'PP', style: 0 },
      { price: ind.pivot_s1, color: '#3fb95088', title: 'S1', style: 2 },
      { price: ind.pivot_s2, color: '#3fb95066', title: 'S2', style: 2 },
    ];
    for (const pl of pivotLines) {
      if (pl.price != null) {
        candleSeries.createPriceLine({
          price: pl.price,
          color: pl.color,
          lineWidth: 1,
          lineStyle: pl.style,
          axisLabelVisible: true,
          title: pl.title,
        });
      }
    }
  }

  document.getElementById('chart-indicators').innerHTML = `
    <div class="indicator-card">
      <div class="label">RSI (14)</div>
      <div class="value ${ind.rsi14 > 70 ? 'negative' : ind.rsi14 < 30 ? 'positive' : ''}">${fmt(ind.rsi14)}</div>
    </div>
    <div class="indicator-card">
      <div class="label">Zmienność (roczna)</div>
      <div class="value">${fmt(ind.volatility)}%</div>
    </div>
    <div class="indicator-card">
      <div class="label">Max Drawdown</div>
      <div class="value negative">${fmt(ind.maxDrawdown)}%</div>
    </div>
    <div class="indicator-card">
      <div class="label">Momentum 5d</div>
      <div class="value ${pnlClass(ind.momentum_5d)}">${fmt((ind.momentum_5d || 0) * 100)}%</div>
    </div>
    <div class="indicator-card">
      <div class="label">Momentum 10d</div>
      <div class="value ${pnlClass(ind.momentum_10d)}">${fmt((ind.momentum_10d || 0) * 100)}%</div>
    </div>
    <div class="indicator-card">
      <div class="label">Siła vs WIG</div>
      <div class="value ${pnlClass(ind.relative_strength)}">${fmt((ind.relative_strength || 0) * 100)}%</div>
    </div>
    <div class="indicator-card">
      <div class="label">Pivot PP</div>
      <div class="value">${fmt(ind.pivot_pp)}</div>
    </div>
    <div class="indicator-card">
      <div class="label">VWAP</div>
      <div class="value">${fmt(ind.vwap_proxy)}</div>
    </div>
    <div class="indicator-card">
      <div class="label">Vol. Ratio</div>
      <div class="value">${fmt(ind.volume_ratio, 1)}x</div>
    </div>
  `;
}

function computeSMA(candles, period) {
  const result = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    result.push({ time: candles[i].date, value: sum / period });
  }
  return result;
}

// ============================================================
// RISK
// ============================================================
async function loadRisk() {
  try {
    const data = await api('/risk/portfolio');

    document.getElementById('risk-exposure').innerHTML = `
      ${fmt(data.exposure * 100)}%
      <div class="risk-meter">
        <div class="fill" style="width:${Math.min(data.exposure * 100, 100)}%;background:${data.exposureOk ? 'var(--green)' : 'var(--red)'}"></div>
      </div>
    `;

    document.getElementById('risk-concentration').innerHTML = `
      ${data.concentrationLevel}
      <div class="risk-meter">
        <div class="fill" style="width:${Math.min(data.concentration * 100, 100)}%;background:${
          data.concentrationLevel === 'LOW' ? 'var(--green)' : data.concentrationLevel === 'MEDIUM' ? 'var(--yellow)' : 'var(--red)'
        }"></div>
      </div>
    `;

    document.getElementById('risk-positions').textContent = `${data.positionCount} / ${data.limits.maxOpenPositions}`;

    const tbody = document.querySelector('#risk-positions-table tbody');
    if (data.positions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted)">Brak pozycji</td></tr>';
    } else {
      const rows = [];
      for (const pos of data.positions) {
        let stops = null;
        try { stops = await api(`/risk/stops/${pos.ticker}`); } catch {}
        rows.push(`
          <tr>
            <td><strong>${pos.ticker}</strong></td>
            <td>${fmt(pos.value)} PLN</td>
            <td>${fmt(pos.portfolioPct)}%</td>
            <td class="${pnlClass(pos.pnlPct)}">${fmt(pos.pnlPct)}%</td>
            <td class="negative">${stops ? fmt(stops.stopLoss) : '—'}</td>
            <td class="positive">${stops ? fmt(stops.takeProfit) : '—'}</td>
          </tr>
        `);
      }
      tbody.innerHTML = rows.join('');
    }

    const l = data.limits;
    document.getElementById('risk-limits').innerHTML = `
      <table style="width:auto">
        <tr><td style="color:var(--text-muted)">Max ekspozycja portfela</td><td><strong>${l.maxPortfolioExposure * 100}%</strong></td></tr>
        <tr><td style="color:var(--text-muted)">Max pozycja</td><td><strong>${l.maxSinglePosition * 100}%</strong></td></tr>
        <tr><td style="color:var(--text-muted)">Kelly fraction</td><td><strong>${l.kellyFraction}</strong></td></tr>
        <tr><td style="color:var(--text-muted)">Max drawdown limit</td><td><strong>${l.maxDrawdownLimit * 100}%</strong></td></tr>
        <tr><td style="color:var(--text-muted)">Stop Loss (ATR×)</td><td><strong>${l.stopLossATRMultiple}</strong></td></tr>
        <tr><td style="color:var(--text-muted)">Take Profit (ATR×)</td><td><strong>${l.takeProfitATRMultiple}</strong></td></tr>
        <tr><td style="color:var(--text-muted)">Min confidence</td><td><strong>${l.minConfidence * 100}%</strong></td></tr>
        <tr><td style="color:var(--text-muted)">Max pozycji</td><td><strong>${l.maxOpenPositions}</strong></td></tr>
      </table>
    `;
  } catch (err) {
    document.getElementById('risk-exposure').textContent = 'Błąd';
    console.error('Risk load error:', err);
  }
}

// ============================================================
// WORKER
// ============================================================
async function loadWorker() {
  try {
    const data = await api('/worker/status');

    document.getElementById('worker-info').innerHTML = `
      <p>Status: <strong style="color:${data.isRunning ? 'var(--green)' : 'var(--red)'}">${data.isRunning ? 'Aktywny' : 'Zatrzymany'}</strong></p>
      <p>Start: <strong>${data.startedAt || '—'}</strong></p>
      <p>Kolejka: <strong>${data.queueSize}</strong> oczekujących</p>
      <p>W trakcie: <strong>${data.runningCount}</strong></p>
      <p>Błędy (perm): <strong class="${data.failedCount > 0 ? 'negative' : ''}">${data.failedCount}</strong></p>
    `;

    document.getElementById('worker-stats').innerHTML = `
      <p>Przetworzono: <strong>${data.jobsProcessed}</strong></p>
      <p>Błędów: <strong>${data.jobsFailed}</strong></p>
      <p>Ostatni ingest: <strong>${data.lastIngest || '—'}</strong></p>
      <p>Ostatni ML: <strong>${data.lastPrediction || '—'}</strong></p>
      <p>Ost. training: <strong>${data.lastTraining || '—'}</strong></p>
    `;

    const jobs = data.recentJobs || [];
    const tbody = document.querySelector('#jobs-table tbody');
    if (jobs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted)">Brak zadań</td></tr>';
    } else {
      tbody.innerHTML = jobs.map(j => `
        <tr>
          <td>${j.id}</td>
          <td><strong>${j.job_type}</strong></td>
          <td class="job-${j.status}">${j.status}</td>
          <td style="font-size:0.8em">${j.created_at}</td>
          <td style="font-size:0.8em">${j.finished_at || '—'}</td>
          <td>${j.retries}</td>
          <td style="font-size:0.8em;color:var(--red)">${j.error || ''}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    document.getElementById('worker-info').innerHTML = `<p class="negative">Błąd: ${err.message}</p>`;
  }
}

document.getElementById('btn-enqueue-pipeline').addEventListener('click', async () => {
  const el = document.getElementById('worker-action-status');
  el.innerHTML = '<span style="color:var(--yellow)">Uruchamiam pipeline...</span>';
  try {
    await api('/pipeline/run', { method: 'POST' });
    el.innerHTML = '<span style="color:var(--green)">Pipeline uruchomiony!</span>';
    loadWorker();
  } catch (err) { el.innerHTML = `<span class="negative">${err.message}</span>`; }
});

document.getElementById('btn-enqueue-ingest').addEventListener('click', async () => {
  await api('/worker/enqueue', { method: 'POST', body: JSON.stringify({ jobType: 'ingest', payload: { mode: 'incremental' } }) });
  document.getElementById('worker-action-status').innerHTML = 'Ingest dodany do kolejki';
  loadWorker();
});

document.getElementById('btn-enqueue-train').addEventListener('click', async () => {
  await api('/worker/enqueue', { method: 'POST', body: JSON.stringify({ jobType: 'train' }) });
  document.getElementById('worker-action-status').innerHTML = 'Training dodany do kolejki';
  loadWorker();
});

document.getElementById('btn-drain-queue').addEventListener('click', async () => {
  const el = document.getElementById('worker-action-status');
  el.innerHTML = '<span style="color:var(--yellow)">Przetwarzam kolejkę...</span>';
  try {
    const data = await api('/worker/drain', { method: 'POST' });
    el.innerHTML = `<span style="color:var(--green)">${data.message}</span>`;
    loadWorker();
  } catch (err) { el.innerHTML = `<span class="negative">${err.message}</span>`; }
});

// ============================================================
// PORTFOLIO
// ============================================================
async function loadPortfolio() {
  loadBalance();
  loadPositions();
  loadTransactions();
}

async function loadBalance() {
  try {
    const data = await api('/portfolio/balance');
    document.getElementById('portfolio-balance').textContent = `${fmt(data.balance)} PLN`;
  } catch {
    document.getElementById('portfolio-balance').textContent = '— PLN';
  }
}

async function loadPositions() {
  try {
    const data = await api('/portfolio/positions');
    const positions = data.positions || [];
    const tbody = document.querySelector('#positions-table tbody');

    if (positions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted)">Brak otwartych pozycji</td></tr>';
      document.getElementById('portfolio-pnl').textContent = '0 PLN';
      return;
    }

    let totalPnl = 0;
    tbody.innerHTML = positions.map((p) => {
      totalPnl += p.pnl;
      return `
        <tr>
          <td><strong>${p.ticker}</strong></td>
          <td>${p.shares}</td>
          <td>${fmt(p.avgPrice)}</td>
          <td>${fmt(p.currentPrice)}</td>
          <td>${fmt(p.value)}</td>
          <td class="${pnlClass(p.pnl)}">${fmt(p.pnl)} PLN</td>
          <td class="${pnlClass(p.pnlPct)}">${fmt(p.pnlPct)}%</td>
        </tr>
      `;
    }).join('');

    document.getElementById('portfolio-pnl').className = `big-number ${pnlClass(totalPnl)}`;
    document.getElementById('portfolio-pnl').textContent = `${fmt(totalPnl)} PLN`;
  } catch {
    document.querySelector('#positions-table tbody').innerHTML =
      '<tr><td colspan="7">Błąd ładowania pozycji</td></tr>';
  }
}

async function loadTransactions() {
  try {
    const data = await api('/portfolio/transactions');
    const txns = data.transactions || [];
    const tbody = document.querySelector('#transactions-table tbody');

    if (txns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted)">Brak transakcji</td></tr>';
      return;
    }

    tbody.innerHTML = txns.map((t) => `
      <tr>
        <td>${t.created_at}</td>
        <td>${t.type}</td>
        <td>${t.ticker || '—'}</td>
        <td>${t.shares || '—'}</td>
        <td>${t.price ? fmt(t.price) : '—'}</td>
        <td>${fmt(t.amount)} PLN</td>
      </tr>
    `).join('');
  } catch { /* ignore */ }
}

document.getElementById('btn-deposit').addEventListener('click', async () => {
  const amount = document.getElementById('deposit-amount').value;
  if (!amount || amount <= 0) return alert('Podaj kwotę wpłaty');
  try {
    await api('/portfolio/deposit', { method: 'POST', body: JSON.stringify({ amount }) });
    loadPortfolio();
  } catch (err) { alert(err.message); }
});

document.getElementById('btn-withdraw').addEventListener('click', async () => {
  const amount = document.getElementById('deposit-amount').value;
  if (!amount || amount <= 0) return alert('Podaj kwotę wypłaty');
  try {
    await api('/portfolio/withdraw', { method: 'POST', body: JSON.stringify({ amount }) });
    loadPortfolio();
  } catch (err) { alert(err.message); }
});

document.getElementById('btn-buy').addEventListener('click', async () => {
  const ticker = document.getElementById('trade-ticker').value;
  const shares = document.getElementById('trade-shares').value;
  if (!ticker || !shares || shares <= 0) return alert('Podaj ticker i ilość');
  try {
    await api('/portfolio/buy', { method: 'POST', body: JSON.stringify({ ticker, shares }) });
    loadPortfolio();
  } catch (err) { alert(err.message); }
});

document.getElementById('btn-sell').addEventListener('click', async () => {
  const ticker = document.getElementById('trade-ticker').value;
  const shares = document.getElementById('trade-shares').value;
  if (!ticker || !shares || shares <= 0) return alert('Podaj ticker i ilość');
  try {
    await api('/portfolio/sell', { method: 'POST', body: JSON.stringify({ ticker, shares }) });
    loadPortfolio();
  } catch (err) { alert(err.message); }
});

// ============================================================
// HEALTH
// ============================================================
async function loadHealth() {
  try {
    const data = await api('/health');
    const statusColor = data.status === 'ok' ? 'var(--green)' : data.status === 'degraded' ? 'var(--yellow)' : 'var(--red)';
    document.getElementById('health-info').innerHTML = `
      <h3>Status API</h3>
      <p>Status: <strong style="color:${statusColor}">${data.status.toUpperCase()}</strong></p>
      <p>Instrumenty: <strong>${data.instruments}</strong></p>
      <p>Świece: <strong>${data.candles.toLocaleString()}</strong></p>
      <p>Ostatni ingest: <strong>${data.lastIngest || 'brak'}</strong></p>
      <h3 class="mt">Providery danych</h3>
      ${data.providers.map(p => `
        <p><span class="status-dot ${p.ok ? 'status-ok' : 'status-err'}"></span> <strong>${p.provider}</strong>
        ${p.candles ? ` – ${p.candles} świec testowych` : ''}
        ${p.error ? `<br><span style="color:var(--red)">${p.error}</span>` : ''}</p>
      `).join('')}
    `;
  } catch {
    document.getElementById('health-info').innerHTML =
      '<p style="color:var(--red)">Nie można połączyć z API. Upewnij się, że serwer działa na porcie 3001.</p>';
  }

  loadIngestLogs();
  loadAuditLogs();
}

async function loadIngestLogs() {
  try {
    const data = await api('/ingest/log?limit=50');
    const logs = data.logs || [];
    document.getElementById('ingest-logs').innerHTML = logs.length === 0
      ? '<p style="color:var(--text-muted)">Brak logów</p>'
      : logs.map((l) => `
        <div style="padding:4px 0;border-bottom:1px solid var(--border)">
          <span class="status-dot ${l.status === 'ok' ? 'status-ok' : 'status-err'}"></span>
          <strong>${l.ticker}</strong> (${l.provider}) – ${l.rows_inserted} nowych
          <span style="color:var(--text-muted);margin-left:8px">${l.created_at}</span>
          ${l.status === 'error' ? `<br><span style="color:var(--red)">${l.message}</span>` : ''}
        </div>
      `).join('');
  } catch { /* ignore */ }
}

async function loadAuditLogs() {
  try {
    const data = await api('/audit?limit=30');
    const logs = data.logs || [];
    const el = document.getElementById('audit-logs');
    if (logs.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted)">Brak wpisów audit</p>';
      return;
    }
    el.innerHTML = logs.map(l => `
      <div style="padding:4px 0;border-bottom:1px solid var(--border)">
        <strong>${l.event_type}</strong> [${l.entity}:${l.entity_id}]
        <span style="color:var(--text-muted);margin-left:8px">${l.created_at}</span>
      </div>
    `).join('');
  } catch { /* ignore */ }
}

document.getElementById('btn-ingest-full').addEventListener('click', async () => {
  const el = document.getElementById('ingest-status');
  el.innerHTML = '<span style="color:var(--yellow)">Pobieranie danych... To może potrwać kilka minut.</span>';
  try {
    const data = await api('/ingest/full', { method: 'POST' });
    el.innerHTML = `<span style="color:var(--green)">Gotowe! ${data.total} nowych świec, ${data.errors} błędów.</span>`;
    loadHealth();
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red)">Błąd: ${err.message}</span>`;
  }
});

document.getElementById('btn-ingest-incr').addEventListener('click', async () => {
  const el = document.getElementById('ingest-status');
  el.innerHTML = '<span style="color:var(--yellow)">Aktualizacja...</span>';
  try {
    const data = await api('/ingest/incremental', { method: 'POST' });
    el.innerHTML = `<span style="color:var(--green)">Gotowe! ${data.total} nowych świec, ${data.errors} błędów.</span>`;
    loadHealth();
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red)">Błąd: ${err.message}</span>`;
  }
});

document.getElementById('btn-compute-features').addEventListener('click', async () => {
  const el = document.getElementById('ingest-status');
  el.innerHTML = '<span style="color:var(--yellow)">Obliczam cechy ML...</span>';
  try {
    const data = await api('/ml/features', { method: 'POST' });
    el.innerHTML = `<span style="color:var(--green)">Obliczono cechy dla ${data.count} instrumentów.</span>`;
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red)">${err.message}</span>`;
  }
});

// ============================================================
// AUTO-REFRESH (every 60s for dashboard, every 5min for chart)
// ============================================================
setInterval(() => {
  const activeView = document.querySelector('.view.active');
  if (activeView?.id === 'view-dashboard') {
    loadTop5();
    loadLiveSignals();
    loadDashPrediction();
    loadDashSignal();
    loadDashWorker();
    loadInstrumentsTable();
  } else if (activeView?.id === 'view-today') {
    loadToday();
  }
}, 60000);

// Chart auto-refresh every 5 min for non-live timeframes (reloads candles for current ticker)
setInterval(() => {
  const activeView = document.querySelector('.view.active');
  if (activeView?.id === 'view-chart') {
    const tf = document.getElementById('chart-timeframe').value;
    // For 5m/1h, WebSocket handles updates; only REST-refresh for 1d
    if (tf === '1d') {
      const ticker = document.getElementById('chart-ticker').value;
      if (ticker) loadChart(ticker);
    }
  } else {
    // Disconnect WS when leaving chart view
    if (wsChart) disconnectChartWS();
  }
}, 300000);

// ============================================================
// INIT – load dashboard on startup
// ============================================================
loadDashboard();

// Periodically refresh Lucide icons for dynamically inserted content
setInterval(() => { if (window.lucide) lucide.createIcons(); }, 2000);

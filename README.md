# GPW Bloomberg — Platforma Analityczna GPW

> Panel analityczny w stylu Bloomberg dla Giełdy Papierów Wartościowych w Warszawie.
> 5-poziomowy łańcuch providerów: **GPW API → Stooq JSON → Stooq CSV → EODHD → Yahoo Finance**.
> Wykresy live (WebSocket 5m), screening, ranking, predykcje ML oraz symulacyjny portfel.

**DISCLAIMER:** Aplikacja ma charakter wyłącznie informacyjny i edukacyjny. Nie stanowi porady inwestycyjnej ani rekomendacji w rozumieniu przepisów prawa. Inwestowanie w instrumenty finansowe wiąże się z ryzykiem utraty kapitału.

---

## Architektura

```
GPW Blooomberg/
packages/shared/       # Wspólne modele, wskaźniki techniczne, mapowania tickerów
apps/api/              # Backend — Express.js + SQLite (sql.js) + WebSocket
  src/
    db/                # Połączenie, migracje, seed, atomowy zapis
    providers/         # 5-poziomowy łańcuch providerów z circuit breaker
    ingest/            # Pipeline pobierania, feedMonitor, intraday 5m
    screener/          # Silnik screeningu i rankingu
    ml/                # Neural network, feature engineering, risk engine
    portfolio/         # Symulacyjny portfel (wpłata/wypłata/kup/sprzedaj)
    worker/            # 24/7 scheduler (cron jobs) + precision KPI watch
    routes/            # REST API ~50 endpointów + auth middleware
    ws/                # WebSocket live 5-minutowe świeczki
apps/web/              # Frontend — vanilla JS + Lightweight Charts
  public/
    index.html
    style.css
    app.js
```

## Źródła danych (5-poziomowy failover)

| Tier | Provider | Instrumenty | Typ |
|------|----------|-------------|-----|
| 1 | GPW API (`GPW_API_KEY`) | Wszystkie | Daily + intraday 5m |
| 2 | Stooq JSON batch | Wszystkie | Daily batch |
| 3 | Stooq CSV | Wszystkie | Daily historical |
| 4 | EODHD (`EODHD_API_KEY`) | Akcje, ETF, indeksy | Daily |
| 5 | Yahoo Finance | Akcje, ETF | Daily |

- Circuit breaker: provider wyłączany po 5 błędach (10 min cooldown)
- Per-ticker circuit: wyłączany po 3 błędach (30 min cooldown)
- Globalny limit HTTP: `GLOBAL_DAILY_HTTP_LIMIT` (domyślnie 500/dzień)

## Instrumenty GPW

Instrumenty przechowywane dynamicznie w tabeli `instruments`. Typowy zestaw:
- **~29 akcji** (WIG20 + mWIG40: PKN, PKO, PZU, KGHM, CDR, ALE, LPP, XTB i więcej)
- **~6 ETF-ów** (WIG20, WIG20 Short, WIG20 Lev, S&P500, DAX, mWIG40)
- **4 indeksy** (WIG, WIG20, mWIG40, sWIG80)
- **2 kontrakty** (FW20, FW40)

## Funkcje

| Moduł | Opis |
|-------|------|
| **Dashboard** | Przegląd rynku, TOP/BOTTOM spółki, lista instrumentów |
| **Predykcje ML** | Neural net + reguły techniczne, predykcje 5-dniowe z freshness gate |
| **Sygnały** | Kelly + ATR stop-loss/take-profit, freshness gate |
| **Screener** | Ranking wg: momentum, RSI, zmienność, wolumen, SMA crossover |
| **Wykresy** | Interaktywne OHLCV + SMA20/50 + wolumen (Lightweight Charts) |
| **Live Feed** | WebSocket `wss://.../ws/live?ticker=X&tf=5m` — live świeczki 5m |
| **Portfel** | Symulacja: wpłata/wypłata PLN, kupno/sprzedaż, PnL, historia |
| **Ryzyko** | Ekspozycja portfela, koncentracja, Kelly criterion |
| **Status** | Health check providerów, circuit breaker state, świeżość danych |

## Szybki start

### Wymagania
- Node.js 18+
- npm

### Zmienne środowiskowe

```bash
ADMIN_API_KEY=<długi-losowy-klucz>    # wymagane w produkcji
CORS_ORIGINS=https://twoja-domena.vercel.app,http://localhost:3001

GPW_API_KEY=<klucz-gpw>               # opcjonalne (tier 1)
EODHD_API_KEY=<klucz-eodhd>           # opcjonalne (tier 4)
GLOBAL_DAILY_HTTP_LIMIT=500
PORT=3001
```

### Instalacja

```bash
cd apps/api
npm install
npm start          # migrate + seed + scheduler + server
```

Frontend na http://localhost:3001.

## API Endpoints (wybór)

POST wymagają nagłówka `X-API-Key: <ADMIN_API_KEY>` lub `Authorization: Bearer <klucz>`.

| Metoda | Endpoint | Auth | Opis |
|--------|----------|------|------|
| GET | `/api/instruments` | — | Lista instrumentów |
| GET | `/api/candles/:ticker` | — | Dane OHLCV + wskaźniki |
| GET | `/api/freshness` | — | Świeżość danych |
| GET | `/api/ranking` | — | Aktualny ranking |
| POST | `/api/ranking/run` | ✓ | Przelicz ranking |
| POST | `/api/ingest/full` | ✓ | Pełny ingest (365 dni) |
| POST | `/api/pipeline/run` | ✓ | Pełny pipeline (202 + polling) |
| GET | `/api/pipeline/status` | — | Status pipeline run |
| GET | `/api/predictions` | — | Predykcje ML + dataAgeSec + stale |
| GET | `/api/signals` | — | Sygnały + dataAgeSec + stale |
| POST | `/api/ml/train` | ✓ | Trening modeli ML (async) |
| GET | `/api/health` | — | Status systemu i providerów |
| WS | `/ws/live?ticker=X&tf=5m` | — | Live 5m świeczki |

## Harmonogram 24/7

| Kiedy | Co |
|------|-----|
| `*/5 9-16 Pn-Pt` | Ingest intraday 5m |
| `*/15 9-17 Pn-Pt` | Ingest przyrostowy |
| `18:00 Pn-Pt` | Trening modeli (async, yield event loop) |
| `18:30 Pn-Pt` | Pełny pipeline |
| `8:00 Sob` | Weekend full ingest + retrain |

## Bezpieczeństwo

- Auth: API key na destruktywnych POST (requireAdmin middleware)
- CORS: ograniczony do CORS_ORIGINS env var
- CSP: script-src 'self' 'unsafe-inline'
- Rate limit: 120 req/min + 3 req/10min na kosztowne operacje
- XSS: wszystkie dane API w innerHTML przepuszczone przez esc()
- SQL: zapytania parametryzowane

## Ograniczenia

- Portfel jest **symulacyjny** — brak realnych transakcji, brak integracji z brokerem
- Nie jest to licencjonowane doradztwo inwestycyjne

## Licencja

MIT — do użytku edukacyjnego i osobistego.

# Audyt Techniczny GPW Bloomberg — 2026-04-04

> Pełny audit pass: bezpieczeństwo, niezawodność, jakość danych/ML, wydajność, pokrycie testami, rozjazdy dokumentacji.
> Stan: 102/102 testów zielonych, 26 plików źródłowych, ~50 endpointów.

---

## Podsumowanie executive

| Kategoria | CRITICAL | HIGH | MEDIUM | LOW |
|-----------|:--------:|:----:|:------:|:---:|
| Bezpieczeństwo | 2 | 4 | 2 | 1 |
| Niezawodność | 1 | 2 | 3 | 1 |
| Jakość danych / ML | — | 1 | 3 | 1 |
| Wydajność | — | 2 | 1 | — |
| Testy / dokumentacja | — | 1 | 1 | 2 |
| **Razem** | **3** | **10** | **10** | **5** |

---

## CRITICAL (natychmiast do naprawy)

### SEC-C1 · Brak autentykacji na wszystkich endpointach

| | |
|-|-|
| **Plik** | [routes/index.js](apps/api/src/routes/index.js), [index.js](apps/api/src/index.js) |
| **Skutek** | Dowolna osoba w internecie może: uruchomić `POST /api/pipeline/run` (kosztowne CPU + spalenie budżetu HTTP), wytrenować modele (`POST /api/ml/train`), dokonać zakupu konkursowego (`POST /api/competition/auto-buy`), wgląd w pełny stan systemu (`GET /api/health`, `/api/worker/status`, `/api/metrics`). |
| **Scenariusz** | Atakujący wysyła `curl -X POST https://app.herokuapp.com/api/pipeline/run` w pętli → 120 req/min × każdy uruchamia `drainQueue()` → wyczerpanie budżetu HTTP + 100% CPU. |
| **Istniejące zabezpieczenie** | Brak. Jedynie rate-limit 120 req/min per IP. |
| **Rekomendacja** | 1) Dodać API key / bearer token na destruktywne endpointy (POST, DELETE). 2) Osobny rate-limit (np. 5/min) na kosztowne POST. 3) Rozważyć IP allowlist na `/api/competition/*`. |

### SEC-C2 · Kosztowne operacje wywoływalne z publicznego API bez ograniczeń

| | |
|-|-|
| **Plik** | [routes/index.js](apps/api/src/routes/index.js#L766) — `POST /pipeline/run`, L702 `POST /ml/train`, L509 `POST /ingest/full` |
| **Skutek** | `POST /pipeline/run` kolejkuje `full_pipeline` (ingest + features + predict + train + screener) i **synchronicznie czeka na drain** — blokuje request handler na 1-10 min, zamraża serwer API. |
| **Istniejące zabezpieczenie** | Rate-limit 120/min, ale jest wspólny dla GET i POST. |
| **Rekomendacja** | 1) Wydzielić oddzielny rate-limit: max 2 req/10min na POST `/pipeline/*`, `/ml/train`, `/ingest/*`. 2) Nie czekać synchronicznie na `drainQueue()` — zwrócić `202 Accepted` + `runId`. 3) Dodać auth (patrz SEC-C1). |

### REL-C1 · saveDb() — nieatomowy zapis do pliku, ryzyko korupcji

| | |
|-|-|
| **Plik** | [db/connection.js](apps/api/src/db/connection.js#L37) |
| **Skutek** | `fs.writeFileSync(DB_PATH, buffer)` jest nieatomowy — jeśli proces crashuje w trakcie zapisu (SIGKILL, OOM-kill Heroku), plik DB jest obcięty lub pusty. Brak WAL, brak backup. |
| **Istniejące zabezpieczenie** | auto-save co 30s, `closeDb()` na SIGTERM/SIGINT. |
| **Rekomendacja** | 1) Zapis atomowy: write do pliku tymczasowego, potem `fs.renameSync(tmpPath, DB_PATH)`. 2) Rotacyjny backup: co N zapisów kopiować `gpw.db.bak`. 3) Logować hash SHA po zapisie → wykrywanie korupcji na starcie. |

---

## HIGH

### SEC-H1 · CSP wyłączony — XSS przy wstrzyknięciu danych

| | |
|-|-|
| **Plik** | [index.js](apps/api/src/index.js#L26) — `contentSecurityPolicy: false` |
| **Skutek** | Brak Content-Security-Policy → jeśli dane z DB (ticker name, error message) trafią do innerHTML bez `esc()`, skrypt atakującego zostanie wykonany. |
| **Łagodzenie** | Frontend używa `esc()` w error-handlerach, ale **nie** na danych tabelarycznych (ticker name, nazwa spółki, reason, sektor). |
| **Rekomendacja** | 1) Włączyć CSP z `script-src 'self'` + nonce na inline scripts. 2) Audit wszystkich `innerHTML` w [app.js](apps/web/public/app.js) pod kątem brakujących `esc()`. |

### SEC-H2 · innerHTML bez esc() na danych z API

| | |
|-|-|
| **Plik** | [app.js](apps/web/public/app.js) — 50+ miejsc z `innerHTML` |
| **Dowód** | Linie 142-153 (`/today`): `a.ticker`, `a.name`, `a.reason` — wstawiane bezpośrednio w template literal. Linie 264-279 (ranking): `r.ticker`, `r.name`. Linia 424 (instrumenty): `inst.name`, `inst.sector`. |
| **Skutek** | Jeśli nazwa instrumentu w DB zawiera HTML/JS, zostanie wyrenderowana jako kod. Wektor: atakujący modyfikuje DB (przez niezabezpieczone POST) lub ticker name zawiera specjalne znaki. |
| **Rekomendacja** | Przepuścić WSZYSTKIE dynamiczne zmienne z API przez `esc()` przed wstawieniem do innerHTML. Alternatywnie: użyć `textContent` lub DOM API. |

### SEC-H3 · CORS wildcard (`origin: '*'`)

| | |
|-|-|
| **Plik** | [index.js](apps/api/src/index.js#L29) |
| **Skutek** | Dowolna strona może wywoływać API z JS przeglądarki. W połączeniu z brakiem auth = pełna kontrola nad aplikacją z obcego origin. |
| **Rekomendacja** | Ograniczyć origin do domen produkcyjnych: `['https://gpw-bloomberg.vercel.app', 'http://localhost:3001']`. |

### SEC-H4 · Hardcoded production URL w frontend

| | |
|-|-|
| **Plik** | [app.js](apps/web/public/app.js#L6) — `PROD_WS_ORIGIN = 'wss://bloomberpl-da6e13c64b4e.herokuapp.com'` |
| **Skutek** | Ujawnienie dokładnego adresu Heroku dyno w publicznym pliku JS. Umożliwia targeted abuse i fingerprinting infrastruktury. |
| **Rekomendacja** | Wynieść do zmiennej konfiguracyjnej (env / build-time inject) lub użyć relative WS path z rewrite. |

### REL-H1 · Brak graceful shutdown WebSocket

| | |
|-|-|
| **Plik** | [liveCandles.js](apps/api/src/ws/liveCandles.js) — `stopPolling()` |
| **Skutek** | `stopPolling()` clearuje timery, ale nie zamyka połączeń WS klientów. Na Heroku dyno restart (co 24h) klienci zostają w limbo bez FIN. `gracefulShutdown()` w [index.js](apps/api/src/index.js#L144) zamyka HTTP server, co zamyka upgrade'd WS, ale dopiero po 10s forced timeout. |
| **Rekomendacja** | W `stopPolling()` dodać: `for (const ws of clients.keys()) ws.close(1001, 'Server shutting down')`. |

### REL-H2 · Synchroniczny drain w POST /pipeline/run

| | |
|-|-|
| **Plik** | [routes/index.js](apps/api/src/routes/index.js#L766) |
| **Skutek** | Request handler oczekuje `await drainQueue()` — jeśli pipeline trwa 5-10 min, HTTP connection trzyma otwartą, Heroku może ją zabić (H12 timeout 30s). Klient dostaje timeout. |
| **Rekomendacja** | Zmienić na `202 Accepted` + zwrócić `runId`. Klient odpytuje `GET /pipeline/status/:runId`. |

### PERF-H1 · trainAll() synchroniczny, blokuje event loop

| | |
|-|-|
| **Plik** | [mlEngine.js](apps/api/src/ml/mlEngine.js) — `trainAll()` iteruje po ~30 tickerach, po 500 iteracji NN na każdy |
| **Skutek** | Trening blokuje single-threaded Node.js na 5-30s per ticker. Podczas treningu: API nie odpowiada, WS nie broadcastuje, heartbeat nie pulsuje → dead client cleanup się spóźnia. |
| **Rekomendacja** | 1) Dodać `await new Promise(r => setImmediate(r))` co N iteracji treningowych (yield to event loop). 2) Lub przenieść trening do `worker_threads`. 3) Ustawić timeout na trainForTicker (np. 30s). |

### PERF-H2 · saveDb() synchroniczny I/O w hot path

| | |
|-|-|
| **Plik** | [connection.js](apps/api/src/db/connection.js#L37) — `fs.writeFileSync()` |
| **Skutek** | Każde `saveDb()` blokuje event loop na czas serializacji + zapisu DB. DB rośnie (aktualnie dane za 365 dni × 41 instrumentów × multiple tables) → milliseconds → tens of milliseconds. Wywoływane: po każdym ingest batch, po treningu, po każdej transakcji portfolio, w auto-save co 30s. |
| **Rekomendacja** | 1) Zamienić na `fs.writeFile()` (async) + callback/promise. 2) Debounce: nie zapisywać częściej niż co 5s. 3) Atomowy write (patrz REL-C1). |

### DATA-H1 · Brak walidacji freshness na endpointach ML

| | |
|-|-|
| **Plik** | [routes/index.js](apps/api/src/routes/index.js#L651) — `GET /predictions`, `GET /signals` |
| **Skutek** | `/predictions` i `/signals` zwracają ostatnie predykcje bez sprawdzania ich wieku. Jeśli pipeline nie uruchamiał się od tygodnia, użytkownik widzi stare sygnały jako aktualne. `/picks/daily` ma freshness gate (600s), ale `/predictions` i `/signals` nie. |
| **Rekomendacja** | Dodać `dataAgeSec` i `stale` flag do `/predictions` i `/signals`, analogicznie jak w `/picks/daily`. |

### TEST-H1 · 5 krytycznych modułów bez testów

| Moduł | Plik | Ryzyko |
|--------|------|--------|
| Provider chain | `providers/*.js` (6 plików) | Failover, retry, circuit breaker, budget tracking — zero testów |
| Portfolio | `portfolioService.js` | Buy/sell/PnL logika finansowa — zero testów |
| WebSocket | `liveCandles.js` | Broadcast, backpressure, cleanup — zero testów |
| DB persistence | `connection.js` | Save/load, crash recovery — zero testów |
| Routes / endpoints | `routes/index.js` | Walidacja wejścia, kontrakty odpowiedzi — zero testów |

**Pokrycie**: 11 suites / 102 testy — pokrywają ML, risk, screener, features, worker. Nie pokrywają: I/O, sieć, persistence, HTTP surface.

---

## MEDIUM

### SEC-M1 · Rate-limit jednolity (GET = POST)

| | |
|-|-|
| **Plik** | [index.js](apps/api/src/index.js#L34) — 120 req/min |
| **Skutek** | Kosztowne POST (pipeline, train, ingest) mają ten sam limit co tanie GET. Atakujący może robić 120 POST/min/IP. |
| **Rekomendacja** | Osobne rate-limit middleware na `/api/pipeline/*`, `/api/ml/train`, `/api/ingest/*`: max 3 req/10min. |

### SEC-M2 · WebSocket bez autentykacji

| | |
|-|-|
| **Plik** | [liveCandles.js](apps/api/src/ws/liveCandles.js#L44) |
| **Skutek** | Dowolna osoba może subskrybować live candles. Niskie ryzyko (dane publiczne), ale umożliwia DDoS na polling loop. |
| **Rekomendacja** | Token w query string lub origin check. Limit subskrypcji per IP (np. 10 tickers). |

### REL-M1 · Auto-deactivation po 3 no-data za agresywna

| | |
|-|-|
| **Plik** | [ingestPipeline.js](apps/api/src/ingest/ingestPipeline.js) — `noDataCount >= 3 → active=0` |
| **Skutek** | Tymczasowy outage providera (np. Stooq weekendowy maintenance) dezaktywuje dobre instrumenty. Ręczna reaktywacja wymagana. |
| **Rekomendacja** | Zwiększyć próg do 5 i dodać auto-reaktywację po powrocie danych. |

### REL-M2 · Budget exhaustion bez alertu zewnętrznego

| | |
|-|-|
| **Plik** | [providers/index.js](apps/api/src/providers/index.js#L128) |
| **Skutek** | `console.warn` + `budgetAlertState.degraded = true` — ale brak webhooka, emaila, Slack notification. System cicho degraduje. |
| **Rekomendacja** | Dodać webhook (Slack/Discord/email) na próg 10% i 0% budżetu. Ustawić `X-Budget-Status: degraded` header. |

### REL-M3 · Single-process architecture

| | |
|-|-|
| **Plik** | [Procfile](Procfile) — `web: node apps/api/src/index.js` |
| **Skutek** | API + scheduler + WS + ML training w jednym procesie Node.js. Trening blokuje API (patrz PERF-H1). Crash jednego = crash wszystkiego. Heroku free/hobby = 1 dyno. |
| **Rekomendacja** | Na tym etapie: yield-to-event-loop w treningu (PERF-H1). Docelowo: worker dyno + `web` dyno. |

### DATA-M1 · Precision KPI delay 24h

| | |
|-|-|
| **Plik** | [jobWorker.js](apps/api/src/worker/jobWorker.js#L60) — `checkPrecisionKPI()` |
| **Skutek** | Sprawdzany raz dziennie (po treningu 18:00). Jeśli model degraduje rano, system serwuje złe sygnały do wieczora. |
| **Rekomendacja** | Dodać check po każdym `predictAll()`, nie tylko po treningu. |

### DATA-M2 · Quality gates za niskie

| | |
|-|-|
| **Plik** | [rankingService.js](apps/api/src/screener/rankingService.js#L23) |
| **Skutek** | `minConfidence: 0.35` (35%), `minExpectedReturn: 0.005` (0.5%) — progi niskie, przepuszczają sygnały o niskiej pewności. |
| **Rekomendacja** | Rozważyć podniesienie: `minConfidence: 0.45`, `minExpectedReturn: 0.01`. Dodać adaptacyjne progi na podstawie reżimu (wyższe w bearish). |

### DATA-M3 · feedMonitor.js — potencjalna SQL injection w tfClause

| | |
|-|-|
| **Plik** | [feedMonitor.js](apps/api/src/ingest/feedMonitor.js#L16-L20) |
| **Kod** | `` `timeframe = '${timeframe === '1h' ? '1h' : '1d'}'` `` |
| **Analiza** | Ternary ogranicza wartość do `'1h'` lub `'1d'` — ale **wzorzec** template-literal w SQL jest niebezpieczny i łamliwy podczas refactoru. Endpoint `/health/feed/:ticker` przekazuje `req.query.timeframe` → `assessFeedQuality()`. |
| **Rekomendacja** | Zamienić na parametryzowane zapytanie: `WHERE timeframe = ?` z whitelist validacją na wejściu. |

### PERF-M1 · Diagnostics/freshness endpoint O(n×3 queries)

| | |
|-|-|
| **Plik** | [routes/index.js](apps/api/src/routes/index.js#L830) — `GET /diagnostics/freshness` |
| **Skutek** | Dla każdego z ~41 instrumentów wykonuje 3 oddzielne SELECT → ~123 queries. Na większym zestawie będzie powolne. |
| **Rekomendacja** | Zrefaktorować do 2-3 agregatowych queries (JOIN + GROUP BY). |

---

## LOW

### SEC-L1 · Health/status leakuje stan wewnętrzny

| | |
|-|-|
| **Plik** | [routes/index.js](apps/api/src/routes/index.js#L613) — `GET /health`, `/status/24x7`, `/metrics`, `/worker/status` |
| **Skutek** | Circuit breaker state, budget stats, provider config — widoczne publicznie. |
| **Rekomendacja** | Po dodaniu auth (SEC-C1) — ukryć za admin scope. |

### DOC-L1 · README nie odpowiada architekturze

| | |
|-|-|
| **Plik** | [README.md](README.md) |
| **Rozbieżności** | 1) README: "Provider: Stooq — jedyne źródło" → Kod: 5-tier chain (GPW, Stooq JSON, Stooq CSV, EODHD, Yahoo). 2) README: "29 akcji, 6 ETF, 4 indeksy, 2 kontrakty" → Kod: dynamiczne z `instruments` table. 3) README: port 3001 → Heroku dynamiczny PORT. 4) Brak opisu WS live feed, competition endpoints, pipeline runs. |
| **Rekomendacja** | Zaktualizować README do stanu faktycznego. |

### DOC-L2 · Duplikat module.exports w portfolioService

| | |
|-|-|
| **Plik** | [portfolioService.js](apps/api/src/portfolio/portfolioService.js#L88-L90) |
| **Kod** | `module.exports = { ... };` powtórzony dwa razy. |
| **Skutek** | Brak wpływu runtime (Node.js bierze ostatni), ale wskazuje na copy-paste i brak linter/review. |

### REL-L1 · apiCached TTL 30s — dashboard polling

| | |
|-|-|
| **Plik** | [app.js](apps/web/public/app.js#L96) |
| **Skutek** | 30s cache na zasoby, które są odświeżane co 15 min (ranking) lub co 60s (ingest). Zbyt krótki TTL → niepotrzebne requesty. |
| **Rekomendacja** | Per-endpoint TTL: 120s dla ranking/predictions, 30s dla portfolio/health. |

### DATA-L1 · Volume zero traktowany jako poprawny

| | |
|-|-|
| **Plik** | [feedMonitor.js](apps/api/src/ingest/feedMonitor.js#L70) |
| **Skutek** | Dla indeksów i futures volume=0 jest normą, ale monitor flaguje >10/20 recent bars → fałszywe alerty dla INDEX type. |
| **Rekomendacja** | Wyłączyć volume check dla INDEX/FUTURES. |

---

## Mapa pokrycia testami

| Moduł | Testy | Status |
|--------|:-----:|--------|
| auditRegression | 12 | ✅ NaN guard, gradient clip, sanitize |
| riskEngine | 14+ | ✅ Kelly, ATR, sell levels, concentration |
| rankingService | 10+ | ✅ Quality gates, scoring, precision |
| featureEngineering | 8+ | ✅ Feature computation, edge cases |
| feedMonitor | 6+ | ✅ Quality checks, gap detection |
| jobWorker | 8+ | ✅ Queue, timeout, recovery |
| competitionAllocation | 6+ | ✅ Budget, rounding, fallback |
| pipelineRun | 6+ | ✅ Run tracking, status |
| topGainersT1 | 6+ | ✅ Train, predict, validate T+1 |
| sectors | 8+ | ✅ Mapping, peers |
| pipeline integration | 4+ | ✅ End-to-end |
| **providers/** | **0** | ❌ Failover, retry, circuit breaker |
| **portfolioService** | **0** | ❌ Buy/sell/PnL logika |
| **liveCandles** | **0** | ❌ WS broadcast, cleanup |
| **connection.js** | **0** | ❌ Save/load, crash safety |
| **routes/index.js** | **0** | ❌ HTTP surface, validation |

---

## Priorytet naprawy (rekomendowana kolejność)

### Blok 1 — Security essentials (tydzień 1)
1. **SEC-C1** Dodać auth (API key) na destruktywne POST endpoints
2. **SEC-C2** Oddzielny rate-limit na kosztowne operacje
3. **SEC-H3** Ograniczyć CORS do produkcyjnych domen
4. **SEC-H2** Przepuścić dynamiczne dane przez `esc()` w app.js
5. **SEC-H1** Włączyć CSP z nonce

### Blok 2 — Reliability (tydzień 2)
6. **REL-C1** Atomowy zapis DB + backup rotacyjny
7. **REL-H2** Async pipeline/run → 202 + polling
8. **REL-H1** Graceful WS shutdown
9. **REL-M1** Auto-deactivation grace period 3→5

### Blok 3 — Data quality (tydzień 3)
10. **DATA-H1** Freshness gate na /predictions i /signals
11. **DATA-M1** Precision KPI po każdym predictAll()
12. **DATA-M2** Podnieść quality gates minConfidence
13. **DATA-M3** Parametryzować SQL w feedMonitor

### Blok 4 — Performance (tydzień 3-4)
14. **PERF-H1** Yield-to-event-loop w trainAll()
15. **PERF-H2** Async saveDb()

### Blok 5 — Test coverage (ciągłe)
16. **TEST-H1** Testy provider chain (mock HTTP)
17. **TEST-H1** Testy portfolioService (unit)
18. **TEST-H1** Testy routes (supertest)

### Blok 6 — Docs & cleanup
19. **DOC-L1** Aktualizacja README
20. **DOC-L2** Usunięcie duplikatu module.exports

---

*Raport wygenerowany 2026-04-04. Wyniki oparte na code-pass + test run (102/102 pass).*

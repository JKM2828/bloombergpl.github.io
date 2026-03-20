# GPW Bloomberg -- Platforma Analityczna GPW

> Panel analityczny w stylu Bloomberg dla Gieldy Papierow Wartosciowych w Warszawie.
> Dane wylacznie z serwisu **Stooq** (darmowe, dzienne swieczkowe). Wykresy, screening, ranking, predykcje ML oraz symulacyjny portfel.

**DISCLAIMER:** Aplikacja ma charakter wylacznie informacyjny i edukacyjny. Nie stanowi porady inwestycyjnej ani rekomendacji w rozumieniu przepisow prawa. Inwestowanie w instrumenty finansowe wiaze sie z ryzykiem utraty kapitalu.

---

## Architektura

```
GPW Blooomberg/
packages/shared/       # Wspolne modele, wskazniki techniczne, mapowania tickerow
apps/api/              # Backend -- Express.js + SQLite (sql.js)
  src/
    db/                # Polaczenie, migracje, seed
    providers/         # Adapter danych: Stooq (jedyne zrodlo)
    ingest/            # Pipeline pobierania i normalizacji danych
    screener/          # Silnik screeningu i rankingu
    ml/                # Neural network, feature engineering, risk engine
    portfolio/         # Symulacyjny portfel (wplata/wyplata/kup/sprzedaj)
    worker/            # 24/7 scheduler (cron jobs)
    routes/            # REST API endpoints
apps/web/              # Frontend -- vanilla JS + Lightweight Charts + Lucide
  public/
    index.html
    style.css
    app.js
```

## Zrodlo danych

- **Provider**: Stooq (stooq.pl) -- jedyne zrodlo, fail-closed (brak danych = brak wyswietlania)
- **Typ**: dzienne swieczki OHLCV (EOD -- end of day)
- **Odswiazanie**: co 15 min w godzinach sesji GPW (Pn-Pt 9:00-17:15), pelny ingest w sobote
- **Opoznienie**: dane sa opoznione (Stooq nie gwarantuje czasu rzeczywistego)
- **Walidacja**: odrzucanie outlierow (>50% skok dzienny), kontrola high>=low, brak wartosci ujemnych

## Instrumenty GPW

- **29 akcji** (WIG20 + selekcja mWIG40: PKN, PKO, PZU, KGHM, CDR, ALE, LPP, DNP, XTB i wiecej)
- **6 ETF-ow** (WIG20, WIG20 Short, WIG20 Lev, S&P500, DAX, mWIG40)
- **4 indeksy** (WIG, WIG20, mWIG40, sWIG80)
- **2 kontrakty** (FW20, FW40)

Kazdy instrument ma przypisany sektor (np. Banki, Energetyka, IT).

## Funkcje

| Modul | Opis |
|-------|------|
| **Dashboard** | Przeglad rynku, TOP/BOTTOM spolki, lista instrumentow z filtrowaniem |
| **Predykcje ML** | Sieci neuronowe + reguly techniczne, predykcje 5-dniowe |
| **Sygnaly** | Rekomendacje z pozycjonowaniem Kelly + ATR stop-loss/take-profit |
| **Screener** | Ranking wg: momentum, RSI, zmiennosc, wolumen, drawdown, SMA crossover |
| **Wykresy** | Interaktywne wykresy OHLCV + SMA20/50 + wolumen (Lightweight Charts) |
| **Portfel** | Symulacja: wplata/wyplata PLN, kupno/sprzedaz akcji, PnL, historia |
| **Ryzyko** | Ekspozycja portfela, koncentracja, Kelly criterion |
| **Status** | Health check Stooq, logi ingest, metryki systemu, swiezosc danych |

## Szybki start

### Wymagania
- Node.js 18+
- npm

### Instalacja

```bash
cd apps/api
npm install

# Uruchom serwer (automatycznie: migrate + seed + scheduler)
npm start
# lub: node src/index.js
```

### Pierwsze uzycie

1. Otworz **http://localhost:3001** -- frontend serwowany statycznie z backendu
2. Przejdz do zakladki **Status** -> kliknij **"Pobierz wszystkie dane"** (pelny ingest ze Stooq)
3. Po zakonczeniu ingest -> **Screener** -> **"Przelicz ranking"**
4. Gotowe! Przegladaj wykresy, ranking i zarzadzaj symulacyjnym portfelem

## API Endpoints

| Metoda | Endpoint | Opis |
|--------|----------|------|
| GET | `/api/instruments` | Lista instrumentow (filter: `?type=STOCK`) |
| GET | `/api/instruments/:ticker` | Profil instrumentu + cena + sektor |
| GET | `/api/candles/:ticker` | Dane OHLCV + wskazniki + swiezosc |
| GET | `/api/freshness` | Swiezosc danych per ticker |
| GET | `/api/ranking` | Aktualny ranking |
| POST | `/api/ranking/run` | Przelicz ranking |
| POST | `/api/ingest/full` | Pelny ingest (365 dni) |
| POST | `/api/ingest/incremental` | Aktualizacja (30 dni) |
| GET | `/api/predictions` | Predykcje ML |
| GET | `/api/signals` | Sygnaly handlowe |
| GET | `/api/risk/portfolio` | Analiza ryzyka portfela |
| GET | `/api/health` | Status systemu i providera Stooq |

## Harmonogram 24/7

| Kiedy | Co | Priorytet |
|-------|----|-----------|
| */15 9-17 Pn-Pt | Ingest przyrostowy | 3 |
| 5,35 9-17 Pn-Pt | Feature computation | 4 |
| 10,40 9-17 Pn-Pt | Predykcje + sygnaly | 5 |
| 15,45 9-17 Pn-Pt | Screener update | 6 |
| 18:00 Pn-Pt | Trening modeli | 2 |
| 18:30 Pn-Pt | Pelny pipeline (ingest+features+predict+screener) | 1 |
| 8:00 Sob | Weekend full ingest + retrain | 1-4 |

## Ograniczenia

- Stooq nie oferuje oficjalnego API -- dane pobierane z CSV endpoint, moga ulec zmianie
- Dane sa dzienne (EOD), nie intraday real-time
- Dane maja charakter best-effort, mozliwe opoznienia lub braki
- Portfel jest **symulacyjny** -- brak realnych transakcji
- Brak integracji z brokerem
- Nie jest to licencjonowane doradztwo inwestycyjne

## Licencja

MIT -- do uzytku edukacyjnego i osobistego.

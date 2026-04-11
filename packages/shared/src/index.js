// ============================================================
// @gpw/shared – Market data models & GPW ticker mappings
// ============================================================

// ---- Instrument types on GPW ----
const InstrumentType = Object.freeze({
  STOCK: 'STOCK',
  ETF: 'ETF',
  INDEX: 'INDEX',
  FUTURES: 'FUTURES',
});

// ---- Candle (OHLCV bar) ----
// { date, open, high, low, close, volume }
function createCandle(date, open, high, low, close, volume) {
  return { date, open, high, low, close, volume };
}

// ---- Instrument descriptor ----
function createInstrument(ticker, name, type, isin = null) {
  return { ticker, name, type, isin };
}

// ---- Data quality score ----
function createQualityScore(provider, ticker, completeness, freshness, notes = '') {
  return { provider, ticker, completeness, freshness, timestamp: new Date().toISOString(), notes };
}

// ---- Ranking result ----
function createRankingEntry(ticker, name, type, score, metrics, reason) {
  return { ticker, name, type, score, metrics, reason, rankedAt: new Date().toISOString() };
}

// ---- Portfolio position ----
function createPosition(ticker, shares, avgPrice, currentPrice) {
  const value = shares * currentPrice;
  const pnl = (currentPrice - avgPrice) * shares;
  const pnlPct = avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
  return { ticker, shares, avgPrice, currentPrice, value, pnl, pnlPct };
}

// ============================================================
// GPW official ticker mappings – Updated 2026-03-17
// Internal ticker = official GPW symbol for all instruments.
// ============================================================

const GPW_STOCKS = [
  { ticker: '11BIT', name: '11 Bit Studios', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'ABPL', name: 'AB SA', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'ACAUTOGAZ', name: 'Ac Autogaz', type: InstrumentType.STOCK, sector: 'Motoryzacja' },
  { ticker: 'AGORA', name: 'Agora', type: InstrumentType.STOCK, sector: 'Media' },
  { ticker: 'AILLERON', name: 'Ailleron', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'ALIOR', name: 'Alior Bank', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'ALLEGRO', name: 'Allegro', type: InstrumentType.STOCK, sector: 'E-commerce' },
  { ticker: 'AMBRA', name: 'Ambra', type: InstrumentType.STOCK, sector: 'Spozywczy' },
  { ticker: 'AMICA', name: 'Amica', type: InstrumentType.STOCK, sector: 'AGD' },
  { ticker: 'AMREST', name: 'AmRest', type: InstrumentType.STOCK, sector: 'Gastronomia' },
  { ticker: 'APATOR', name: 'Apator', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'ARCHICOM', name: 'Archicom', type: InstrumentType.STOCK, sector: 'Nieruchomosci' },
  { ticker: 'ARCTIC', name: 'Arctic Paper', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'ARLEN', name: 'Arlen', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'ASBIS', name: 'Asbis', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'ASSECOBS', name: 'Asseco BS', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'ASSECOPOL', name: 'Asseco Poland', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'ASSECOSEE', name: 'Asseco SEE', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'ASTARTA', name: 'Astarta', type: InstrumentType.STOCK, sector: 'Rolnictwo' },
  { ticker: 'ATAL', name: 'Atal', type: InstrumentType.STOCK, sector: 'Nieruchomosci' },
  { ticker: 'AUTOPARTN', name: 'Auto Partner', type: InstrumentType.STOCK, sector: 'Motoryzacja' },
  { ticker: 'BENEFIT', name: 'Benefit Systems', type: InstrumentType.STOCK, sector: 'Uslugi' },
  { ticker: 'BIOCELTIX', name: 'Bioceltix', type: InstrumentType.STOCK, sector: 'Biotechnologia' },
  { ticker: 'BIOTON', name: 'Bioton', type: InstrumentType.STOCK, sector: 'Biotechnologia' },
  { ticker: 'BLOOBER', name: 'Bloober Team', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'BNPPPL', name: 'BNP Paribas PL', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'BOGDANKA', name: 'LW Bogdanka', type: InstrumentType.STOCK, sector: 'Gornictwo' },
  { ticker: 'BORYSZEW', name: 'Boryszew', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'BOS', name: 'BOŚ Bank', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'BUDIMEX', name: 'Budimex', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'BUMECH', name: 'Bumech', type: InstrumentType.STOCK, sector: 'Gornictwo' },
  { ticker: 'CAPTORTX', name: 'Captor Therapeutics', type: InstrumentType.STOCK, sector: 'Biotechnologia' },
  { ticker: 'CDPROJEKT', name: 'CD Projekt', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'CIGAMES', name: 'CI Games', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'CLNPHARMA', name: 'Celon Pharma', type: InstrumentType.STOCK, sector: 'Farmaceutyka' },
  { ticker: 'COGNOR', name: 'Cognor', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'COLUMBUS', name: 'Columbus Energy', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'COMP', name: 'Comp SA', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'CREEPYJAR', name: 'Creepy Jar', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'CREOTECH', name: 'Creotech Instruments', type: InstrumentType.STOCK, sector: 'Technologia' },
  { ticker: 'CYBERFLKS', name: 'Cyberfolks', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'CYFRPLSAT', name: 'Cyfrowy Polsat', type: InstrumentType.STOCK, sector: 'Media' },
  { ticker: 'DADELO', name: 'Dadelo', type: InstrumentType.STOCK, sector: 'E-commerce' },
  { ticker: 'DATAWALK', name: 'DataWalk', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'DECORA', name: 'Decora', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'DEVELIA', name: 'Develia', type: InstrumentType.STOCK, sector: 'Nieruchomosci' },
  { ticker: 'DIAG', name: 'Diagnostyka', type: InstrumentType.STOCK, sector: 'Medycyna' },
  { ticker: 'DIGITANET', name: 'Digitanet', type: InstrumentType.STOCK, sector: 'Telekomunikacja' },
  { ticker: 'DINOPL', name: 'Dino Polska', type: InstrumentType.STOCK, sector: 'Handel detaliczny' },
  { ticker: 'DOMDEV', name: 'Dom Development', type: InstrumentType.STOCK, sector: 'Nieruchomosci' },
  { ticker: 'ECHO', name: 'Echo Investment', type: InstrumentType.STOCK, sector: 'Nieruchomosci' },
  { ticker: 'ELEKTROTI', name: 'Elektrotim', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'ENEA', name: 'Enea', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'ENTER', name: 'Enter Air', type: InstrumentType.STOCK, sector: 'Turystyka' },
  { ticker: 'ERBUD', name: 'Erbud', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'EUROCASH', name: 'Eurocash', type: InstrumentType.STOCK, sector: 'Handel detaliczny' },
  { ticker: 'FERRO', name: 'Ferro', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'FORTE', name: 'Forte', type: InstrumentType.STOCK, sector: 'Meble' },
  { ticker: 'GPW', name: 'GPW SA', type: InstrumentType.STOCK, sector: 'Finanse' },
  { ticker: 'GREENX', name: 'GreenX Metals', type: InstrumentType.STOCK, sector: 'Surowce' },
  { ticker: 'GRUPAAZOTY', name: 'Grupa Azoty', type: InstrumentType.STOCK, sector: 'Chemia' },
  { ticker: 'GRUPRACUJ', name: 'Grupa Pracuj', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'HANDLOWY', name: 'Bank Handlowy', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'HUUUGE', name: 'Huuuge', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'INGBSK', name: 'ING BSK', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'INTERCARS', name: 'Inter Cars', type: InstrumentType.STOCK, sector: 'Motoryzacja' },
  { ticker: 'JSW', name: 'JSW', type: InstrumentType.STOCK, sector: 'Gornictwo' },
  { ticker: 'KETY', name: 'Kety', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'KGHM', name: 'KGHM', type: InstrumentType.STOCK, sector: 'Surowce' },
  { ticker: 'KOGENERA', name: 'Kogeneracja', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'KRUK', name: 'Kruk', type: InstrumentType.STOCK, sector: 'Windykacja' },
  { ticker: 'LPP', name: 'LPP', type: InstrumentType.STOCK, sector: 'Odziez i moda' },
  { ticker: 'LUBAWA', name: 'Lubawa', type: InstrumentType.STOCK, sector: 'Obronnosc' },
  { ticker: 'MABION', name: 'Mabion', type: InstrumentType.STOCK, sector: 'Biotechnologia' },
  { ticker: 'MBANK', name: 'mBank', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'MCI', name: 'MCI Capital', type: InstrumentType.STOCK, sector: 'Finanse' },
  { ticker: 'MCR', name: 'Macrologic', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'MEDICALG', name: 'Medicalgorithmics', type: InstrumentType.STOCK, sector: 'Medycyna' },
  { ticker: 'MENNICA', name: 'Mennica Polska', type: InstrumentType.STOCK, sector: 'Finanse' },
  { ticker: 'MERCATOR', name: 'Mercator Medical', type: InstrumentType.STOCK, sector: 'Medycyna' },
  { ticker: 'MILLENNIUM', name: 'Millennium', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'MIRBUD', name: 'Mirbud', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'MLPGROUP', name: 'MLP Group', type: InstrumentType.STOCK, sector: 'Logistyka' },
  { ticker: 'MLSYSTEM', name: 'ML System', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'MOBRUK', name: 'Mo-BRUK', type: InstrumentType.STOCK, sector: 'Odpady' },
  { ticker: 'MODIVO', name: 'Modivo', type: InstrumentType.STOCK, sector: 'E-commerce' },
  { ticker: 'MOSTALZAB', name: 'Mostostal Zabrze', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'MURAPOL', name: 'Murapol', type: InstrumentType.STOCK, sector: 'Nieruchomosci' },
  { ticker: 'NEUCA', name: 'Neuca', type: InstrumentType.STOCK, sector: 'Farmaceutyka' },
  { ticker: 'NEWAG', name: 'Newag', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'ONDE', name: 'Onde', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'OPONEO.PL', name: 'Oponeo.pl', type: InstrumentType.STOCK, sector: 'E-commerce' },
  { ticker: 'ORANGEPL', name: 'Orange Polska', type: InstrumentType.STOCK, sector: 'Telekomunikacja' },
  { ticker: 'PCCROKITA', name: 'PCC Rokita', type: InstrumentType.STOCK, sector: 'Chemia' },
  { ticker: 'PEKABEX', name: 'Pekabex', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'PEKAO', name: 'Pekao', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'PEP', name: 'Polenergia', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'PEPCO', name: 'Pepco Group', type: InstrumentType.STOCK, sector: 'Handel detaliczny' },
  { ticker: 'PGE', name: 'PGE', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'PKNORLEN', name: 'PKN Orlen', type: InstrumentType.STOCK, sector: 'Paliwa i gaz' },
  { ticker: 'PKOBP', name: 'PKO BP', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'PLAYWAY', name: 'PlayWay', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'POLIMEXMS', name: 'Polimex Mostostal', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'PZU', name: 'PZU', type: InstrumentType.STOCK, sector: 'Ubezpieczenia' },
  { ticker: 'QUERCUS', name: 'Quercus TFI', type: InstrumentType.STOCK, sector: 'Finanse' },
  { ticker: 'RAINBOW', name: 'Rainbow Tours', type: InstrumentType.STOCK, sector: 'Turystyka' },
  { ticker: 'RYVU', name: 'Ryvu Therapeutics', type: InstrumentType.STOCK, sector: 'Biotechnologia' },
  { ticker: 'SANOK', name: 'Sanok Rubber', type: InstrumentType.STOCK, sector: 'Motoryzacja' },
  { ticker: 'SANPL', name: 'Santander PL', type: InstrumentType.STOCK, sector: 'Banki' },
  { ticker: 'SCPFL', name: 'Scope Fluidics', type: InstrumentType.STOCK, sector: 'Biotechnologia' },
  { ticker: 'SELENAFM', name: 'Selena FM', type: InstrumentType.STOCK, sector: 'Chemia' },
  { ticker: 'SELVITA', name: 'Selvita', type: InstrumentType.STOCK, sector: 'Biotechnologia' },
  { ticker: 'SHOPER', name: 'Shoper', type: InstrumentType.STOCK, sector: 'E-commerce' },
  { ticker: 'SNIEZKA', name: 'Śnieżka', type: InstrumentType.STOCK, sector: 'Chemia' },
  { ticker: 'SNTVERSE', name: 'Suntverse', type: InstrumentType.STOCK, sector: 'Technologia' },
  { ticker: 'STALEXP', name: 'Stalexport', type: InstrumentType.STOCK, sector: 'Infrastruktura' },
  { ticker: 'STALPROD', name: 'Stalprodukt', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'SYGNITY', name: 'Sygnity', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'SYNEKTIK', name: 'Synektik', type: InstrumentType.STOCK, sector: 'Medycyna' },
  { ticker: 'TARCZYNSKI', name: 'Tarczyński', type: InstrumentType.STOCK, sector: 'Spozywczy' },
  { ticker: 'TAURONPE', name: 'Tauron', type: InstrumentType.STOCK, sector: 'Energetyka' },
  { ticker: 'TEXT', name: 'Text (LiveChat)', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'TORPOL', name: 'Torpol', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'TOYA', name: 'Toya', type: InstrumentType.STOCK, sector: 'Przemysl' },
  { ticker: 'TSGAMES', name: 'Ten Square Games', type: InstrumentType.STOCK, sector: 'Gry i rozrywka' },
  { ticker: 'UNIBEP', name: 'Unibep', type: InstrumentType.STOCK, sector: 'Budownictwo' },
  { ticker: 'UNIMOT', name: 'Unimot', type: InstrumentType.STOCK, sector: 'Paliwa i gaz' },
  { ticker: 'VERCOM', name: 'Vercom', type: InstrumentType.STOCK, sector: 'IT' },
  { ticker: 'VIGOPHOTN', name: 'Vigo Photonics', type: InstrumentType.STOCK, sector: 'Technologia' },
  { ticker: 'VOTUM', name: 'Votum', type: InstrumentType.STOCK, sector: 'Uslugi' },
  { ticker: 'VOXEL', name: 'Voxel', type: InstrumentType.STOCK, sector: 'Medycyna' },
  { ticker: 'VRG', name: 'VRG SA', type: InstrumentType.STOCK, sector: 'Odziez i moda' },
  { ticker: 'WAWEL', name: 'Wawel', type: InstrumentType.STOCK, sector: 'Spozywczy' },
  { ticker: 'WIELTON', name: 'Wielton', type: InstrumentType.STOCK, sector: 'Motoryzacja' },
  { ticker: 'WIRTUALNA', name: 'Wirtualna Polska', type: InstrumentType.STOCK, sector: 'Media' },
  { ticker: 'WITTCHEN', name: 'Wittchen', type: InstrumentType.STOCK, sector: 'Odziez i moda' },
  { ticker: 'XTB', name: 'XTB', type: InstrumentType.STOCK, sector: 'Finanse' },
  { ticker: 'XTPL', name: 'XTPL', type: InstrumentType.STOCK, sector: 'Technologia' },
  { ticker: 'ZABKA', name: 'Żabka Group', type: InstrumentType.STOCK, sector: 'Handel detaliczny' },
  { ticker: 'ZEPAK', name: 'ZE PAK', type: InstrumentType.STOCK, sector: 'Energetyka' },
];

const GPW_ETFS = [
  { ticker: 'ETFBCASH', name: 'Beta ETF Cash', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBDIVPL', name: 'Beta ETF Dividend PL', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBM40TR', name: 'Beta ETF mWIG40 TR', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBNDXPL', name: 'Beta ETF NASDAQ PLN', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBNQ2ST', name: 'Beta ETF NASDAQ 2x Short', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBNQ3LV', name: 'Beta ETF NASDAQ 3x Lev.', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBS80TR', name: 'Beta ETF sWIG80 TR', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBSPXPL', name: 'Beta ETF S&P500 PLN-Hedged', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBTBSP', name: 'Beta ETF TBSP', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBTCPL', name: 'Beta ETF Bitcoin PLN', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBW20LV', name: 'Beta ETF WIG20 Leveraged', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBW20ST', name: 'Beta ETF WIG20 Short', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFBW20TR', name: 'Beta ETF WIG20 TR', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFDAX', name: 'Beta ETF DAX', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFNATO', name: 'Beta ETF NATO', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFPZUW20M40', name: 'PZU ETF WIG20+mWIG40', type: InstrumentType.ETF, sector: 'ETF' },
  { ticker: 'ETFSP500', name: 'Beta ETF S&P500', type: InstrumentType.ETF, sector: 'ETF' },
];

const GPW_INDICES = [
  { ticker: 'WIG', name: 'WIG', type: InstrumentType.INDEX, sector: 'Indeks' },
  { ticker: 'WIG20', name: 'WIG20', type: InstrumentType.INDEX, sector: 'Indeks' },
  { ticker: 'MWIG40', name: 'mWIG40', type: InstrumentType.INDEX, sector: 'Indeks' },
  { ticker: 'SWIG80', name: 'sWIG80', type: InstrumentType.INDEX, sector: 'Indeks' },
];

const GPW_FUTURES = [
  // Index futures
  { ticker: 'FW20', name: 'Kontrakt FW20 (biezacy)', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FW40', name: 'Kontrakt FW40 (biezacy)', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  // Single-stock futures
  { ticker: 'F11B', name: 'Kontrakt na 11BIT', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FALR', name: 'Kontrakt na ALIOR', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FALE', name: 'Kontrakt na ALLEGRO', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FEAT', name: 'Kontrakt na ATAL', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FASB', name: 'Kontrakt na ASBIS', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FACP', name: 'Kontrakt na ASSECO', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FAPR', name: 'Kontrakt na APATOR', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FMIL', name: 'Kontrakt na MILLENNIUM', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPEO', name: 'Kontrakt na PEPCO', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FCDR', name: 'Kontrakt na CDPROJEKT', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FCPS', name: 'Kontrakt na CYFRPOLSAT', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FDIA', name: 'Kontrakt na DINOPL', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FDNP', name: 'Kontrakt na DEVELIA', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FDOM', name: 'Kontrakt na DOMDEV', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FENA', name: 'Kontrakt na ENEA', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FEUH', name: 'Kontrakt na EUROCASH', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FGPW', name: 'Kontrakt na GPW', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FATT', name: 'Kontrakt na GRUPAAZOTY', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FBDX', name: 'Kontrakt na BUDIMEX', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FKTY', name: 'Kontrakt na KETY', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FING', name: 'Kontrakt na INGBSK', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FCAR', name: 'Kontrakt na INTERCARS', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FJSW', name: 'Kontrakt na JSW', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FKGH', name: 'Kontrakt na KGHM', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FKRU', name: 'Kontrakt na KRUK', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FLPP', name: 'Kontrakt na LPP', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FLWB', name: 'Kontrakt na LIVECHAT', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FMAB', name: 'Kontrakt na MABION', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FMBK', name: 'Kontrakt na MBANK', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FMDV', name: 'Kontrakt na MEDICALG', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FOPL', name: 'Kontrakt na ORANGEPL', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPCO', name: 'Kontrakt na PEPCO', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPGE', name: 'Kontrakt na PGE', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPKP', name: 'Kontrakt na PKPCARGO', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPXM', name: 'Kontrakt na POLIMEX', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPKN', name: 'Kontrakt na PKNORLEN', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPKO', name: 'Kontrakt na PKOBP', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FPZU', name: 'Kontrakt na PZU', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FSPL', name: 'Kontrakt na SANPL', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FSVE', name: 'Kontrakt na SILVAIR', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FTPE', name: 'Kontrakt na TAURONPE', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FTEN', name: 'Kontrakt na TENSQUARE', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FXTB', name: 'Kontrakt na XTB', type: InstrumentType.FUTURES, sector: 'Derywaty' },
  { ticker: 'FZAB', name: 'Kontrakt na ZABKA', type: InstrumentType.FUTURES, sector: 'Derywaty' },
];

const ALL_INSTRUMENTS = [...GPW_STOCKS, ...GPW_ETFS, ...GPW_INDICES, ...GPW_FUTURES];

// ---- Technical indicator helpers ----
function sma(candles, period) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + c.close, 0) / period;
}

function ema(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    emaVal = candles[i].close * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function maxDrawdown(candles) {
  let peak = -Infinity, maxDD = 0;
  for (const c of candles) {
    if (c.close > peak) peak = c.close;
    const dd = (peak - c.close) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function volatility(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const returns = [];
  const slice = candles.slice(-period - 1);
  for (let i = 1; i < slice.length; i++) {
    returns.push((slice[i].close - slice[i - 1].close) / slice[i - 1].close);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252); // annualized
}

module.exports = {
  InstrumentType,
  createCandle,
  createInstrument,
  createQualityScore,
  createRankingEntry,
  createPosition,
  GPW_STOCKS,
  GPW_ETFS,
  GPW_INDICES,
  GPW_FUTURES,
  ALL_INSTRUMENTS,
  sma,
  ema,
  rsi,
  maxDrawdown,
  volatility,
};

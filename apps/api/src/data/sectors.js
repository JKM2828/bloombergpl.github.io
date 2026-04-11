// ============================================================
// GPW Sector Classification
// Maps tickers to sectors for relative-strength computation.
// ============================================================

const SECTOR_MAP = {
  // Banki
  PKOBP: 'banki', PEKAO: 'banki', MBANK: 'banki', SANPL: 'banki', HANDLOWY: 'banki', INGBSK: 'banki', MILLENNIUM: 'banki', ALIOR: 'banki', BNPPPL: 'banki', BOS: 'banki',
  // Energia / Paliwa
  PKNORLEN: 'energia', PGE: 'energia', TAURONPE: 'energia', ENEA: 'energia', ZEPAK: 'energia',
  // Ubezpieczenia
  PZU: 'ubezpieczenia',
  // Retail / Odzież
  LPP: 'retail', DINOPL: 'retail', PEPCO: 'retail',
  // Technologia / IT / Gaming
  CDPROJEKT: 'technologia', PLAYWAY: 'technologia', ASSECOBS: 'technologia', '11BIT': 'technologia', CIGAMES: 'technologia',
  // Telekomunikacja
  ORANGEPL: 'telekomunikacja', CYFRPLSAT: 'telekomunikacja',
  // Surowce / Chemia
  KGHM: 'surowce', JSW: 'surowce', STALPROD: 'chemia', GRUPAAZOTY: 'chemia',
  // Deweloperzy / Nieruchomości
  DOMDEV: 'nieruchomosci', ECHO: 'nieruchomosci', ARCTIC: 'nieruchomosci', DEVELIA: 'nieruchomosci',
  // Budownictwo
  BUDIMEX: 'budownictwo', UNIBEP: 'budownictwo', ERBUD: 'budownictwo', TORPOL: 'budownictwo',
  // Przemysł / Automotive
  KETY: 'przemysl',
  // Spożywcze
  AMBRA: 'spozywcze', KRUK: 'spozywcze',
  // Medycyna / Farmacja
  BIOTON: 'medycyna',
  // Media
  AGORA: 'media', WIRTUALNA: 'media',
  // Usługi finansowe
  XTB: 'finanse', GPW: 'finanse', PEP: 'finanse', INTERCARS: 'finanse',
  // Indeksy (reference)
  WIG: 'indeks', WIG20: 'indeks', MWIG40: 'indeks', SWIG80: 'indeks',
  // Futures – index
  FW20: 'futures', FW40: 'futures',
  // Futures – single-stock
  F11B: 'futures', FALR: 'futures', FALE: 'futures', FEAT: 'futures', FASB: 'futures',
  FACP: 'futures', FAPR: 'futures', FMIL: 'futures', FPEO: 'futures', FCDR: 'futures',
  FCPS: 'futures', FDIA: 'futures', FDNP: 'futures', FDOM: 'futures', FENA: 'futures',
  FEUH: 'futures', FGPW: 'futures', FATT: 'futures', FBDX: 'futures', FKTY: 'futures',
  FING: 'futures', FCAR: 'futures', FJSW: 'futures', FKGH: 'futures', FKRU: 'futures',
  FLPP: 'futures', FLWB: 'futures', FMAB: 'futures', FMBK: 'futures', FMDV: 'futures',
  FOPL: 'futures', FPCO: 'futures', FPGE: 'futures', FPKP: 'futures', FPXM: 'futures',
  FPKN: 'futures', FPKO: 'futures', FPZU: 'futures', FSPL: 'futures', FSVE: 'futures',
  FTPE: 'futures', FTEN: 'futures', FXTB: 'futures', FZAB: 'futures',
};

// Sector → representative index ticker (for sector-RS calculation)
const SECTOR_INDEX = {
  banki: 'WIG', energia: 'WIG', ubezpieczenia: 'WIG', retail: 'WIG',
  technologia: 'WIG', telekomunikacja: 'WIG', surowce: 'WIG', chemia: 'WIG',
  nieruchomosci: 'WIG', budownictwo: 'WIG', przemysl: 'WIG', spozywcze: 'WIG',
  medycyna: 'WIG', media: 'WIG', finanse: 'WIG', logistyka: 'WIG',
  indeks: null, futures: null,
};

function getSector(ticker) {
  return SECTOR_MAP[ticker] || 'inne';
}

function getSectorPeers(ticker) {
  const sector = getSector(ticker);
  if (!sector || sector === 'indeks' || sector === 'futures') return [];
  return Object.entries(SECTOR_MAP)
    .filter(([t, s]) => s === sector && t !== ticker)
    .map(([t]) => t);
}

function getAllSectors() {
  const sectors = {};
  for (const [ticker, sector] of Object.entries(SECTOR_MAP)) {
    if (!sectors[sector]) sectors[sector] = [];
    sectors[sector].push(ticker);
  }
  return sectors;
}

module.exports = { SECTOR_MAP, SECTOR_INDEX, getSector, getSectorPeers, getAllSectors };

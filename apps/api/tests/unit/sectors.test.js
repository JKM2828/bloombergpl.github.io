// ============================================================
// Unit tests: sectors.js
// ============================================================
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getSector, getSectorPeers, getAllSectors, SECTOR_MAP } = require('../../src/data/sectors');

describe('sectors', () => {
  describe('getSector', () => {
    it('returns correct sector for known tickers', () => {
      assert.equal(getSector('PKOBP'), 'banki');
      assert.equal(getSector('CDPROJEKT'), 'technologia');
      assert.equal(getSector('KGHM'), 'surowce');
      assert.equal(getSector('PZU'), 'ubezpieczenia');
      assert.equal(getSector('WIG20'), 'indeks');
      assert.equal(getSector('FW20'), 'futures');
    });

    it('returns "inne" for unknown tickers', () => {
      assert.equal(getSector('UNKNOWN'), 'inne');
      assert.equal(getSector(''), 'inne');
    });
  });

  describe('getSectorPeers', () => {
    it('returns peers excluding the ticker itself', () => {
      const peers = getSectorPeers('PKOBP');
      assert.ok(peers.length > 0, 'Should have at least one peer');
      assert.ok(!peers.includes('PKOBP'), 'Should not include self');
      assert.ok(peers.includes('PEKAO'), 'PEKAO should be a banking peer');
    });

    it('returns empty array for index tickers', () => {
      assert.deepEqual(getSectorPeers('WIG20'), []);
    });

    it('returns empty array for futures', () => {
      assert.deepEqual(getSectorPeers('FW20'), []);
    });
  });

  describe('getAllSectors', () => {
    it('returns object with sector keys', () => {
      const sectors = getAllSectors();
      assert.ok(typeof sectors === 'object');
      assert.ok('banki' in sectors);
      assert.ok('technologia' in sectors);
      assert.ok(sectors.banki.length > 0);
    });
  });

  describe('SECTOR_MAP', () => {
    it('covers major WIG20 constituents', () => {
      const wig20Core = ['PKOBP', 'PEKAO', 'PKNORLEN', 'KGHM', 'CDPROJEKT', 'PZU', 'LPP', 'PGE', 'ORANGEPL'];
      for (const ticker of wig20Core) {
        assert.ok(ticker in SECTOR_MAP, `${ticker} should be in SECTOR_MAP`);
      }
    });
  });
});

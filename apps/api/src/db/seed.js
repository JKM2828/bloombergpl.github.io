// ============================================================
// Seed instruments into DB from shared ticker list
// ============================================================
const { run, saveDb } = require('./connection');
const { migrate } = require('./migrate');
const { ALL_INSTRUMENTS } = require('../../../../packages/shared/src');
const { query } = require('./connection');

async function seed() {
  await migrate();

  for (const inst of ALL_INSTRUMENTS) {
    run(
      'INSERT OR REPLACE INTO instruments (ticker, name, type, isin, sector) VALUES (?, ?, ?, ?, ?)',
      [inst.ticker, inst.name, inst.type, inst.isin || null, inst.sector || null]
    );
  }

  // Deactivate instruments no longer in universe (e.g. LTS/Lotos removed)
  const activeTickers = ALL_INSTRUMENTS.map(i => i.ticker);
  const placeholder = activeTickers.map(() => '?').join(',');
  run(`UPDATE instruments SET active = 0 WHERE ticker NOT IN (${placeholder})`, activeTickers);

  saveDb();
  const row = query('SELECT count(*) as n FROM instruments');
  const count = row[0]?.n || 0;
  console.log(`[seed] ${count} instruments in database.`);
}

if (require.main === module) {
  seed().then(() => process.exit(0));
}

module.exports = { seed };

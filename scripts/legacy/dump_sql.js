const Database = require('better-sqlite3');
const fs = require('fs');

const sourceDb = new Database('data/zhihu.db', { readonly: true });
const tables = ['contents', 'comments', 'collections', 'collection_items', 'upvotes', 'change_events', 'sync_runs'];

let sql = '';
for (const table of tables) {
  try {
    const rows = sourceDb.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    for (const row of rows) {
      const values = cols.map(c => {
        const val = row[c];
        if (val === null) return 'NULL';
        if (typeof val === 'number') return val;
        return `'${val.toString().replace(/'/g, "''")}'`;
      });
      sql += `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${values.join(', ')});\n`;
    }
  } catch (e) {
    console.error(`Error table ${table}:`, e.message);
  }
}
fs.writeFileSync('dump.sql', sql);
sourceDb.close();
console.log('Dump created at dump.sql');

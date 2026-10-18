const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const sourceDb = new Database('data/zhihu.db', { readonly: true });
const targetDir = 'apps/worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';

const files = fs.readdirSync(targetDir);
const sqliteFile = files.find(f => f.endsWith('.sqlite'));

if (!sqliteFile) {
  console.error("No sqlite file found in D1 state dir");
  process.exit(1);
}

const targetDbPath = path.join(targetDir, sqliteFile);
console.log(`Copying data to ${targetDbPath}`);

const targetDb = new Database(targetDbPath);

const tables = ['contents', 'comments', 'collections', 'collection_items', 'upvotes', 'change_events', 'sync_runs'];

for (const table of tables) {
  try {
    const rows = sourceDb.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) continue;
    console.log(`Copying ${rows.length} rows for ${table}...`);
    
    // Determine columns
    const cols = Object.keys(rows[0]);
    
    // Check if target has these columns
    const targetColsInfo = targetDb.prepare(`PRAGMA table_info(${table})`).all();
    const targetColNames = targetColsInfo.map(c => c.name);
    
    const validCols = cols.filter(c => targetColNames.includes(c));
    if (validCols.length === 0) continue;

    const placeholders = validCols.map(() => '?').join(', ');
    const insertStmt = targetDb.prepare(`INSERT OR IGNORE INTO ${table} (${validCols.join(', ')}) VALUES (${placeholders})`);
    
    const insertMany = targetDb.transaction((rows) => {
      for (const row of rows) {
        insertStmt.run(validCols.map(c => row[c]));
      }
    });
    
    insertMany(rows);
    console.log(`Finished ${table}`);
  } catch (e) {
    console.error(`Error copying table ${table}:`, e.message);
  }
}

sourceDb.close();
targetDb.close();
console.log("Done!");

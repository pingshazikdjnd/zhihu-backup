import Database from 'better-sqlite3';
const db = new Database('../../data/zhihu.db');
console.log(db.prepare('PRAGMA table_info(contents)').all());

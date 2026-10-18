const db = require('better-sqlite3')('../../data/zhihu.db');
console.log(db.prepare('PRAGMA table_info(contents)').all());

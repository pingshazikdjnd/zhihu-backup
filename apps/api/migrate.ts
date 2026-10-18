import { db } from './src/db.js';

try {
  db.exec('ALTER TABLE contents ADD COLUMN favorite_count INTEGER NOT NULL DEFAULT 0');
  console.log('Added favorite_count');
} catch (e) {
  console.log('favorite_count already exists');
}

try {
  db.exec('ALTER TABLE contents ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 0');
  console.log('Added visit_count');
} catch (e) {
  console.log('visit_count already exists');
}

console.log('Migration done.');

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../../");
const dbPath = process.env.DB_PATH
  ? path.resolve(rootDir, process.env.DB_PATH)
  : path.resolve(rootDir, "data/app.db");

const schemaPath = path.resolve(rootDir, "data/schema.sql");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 transaction，这里挂一个同构包装器
type DbWithTransaction = DatabaseSync & {
  transaction: <T>(fn: () => T) => () => T;
};

const dbInstance = new DatabaseSync(dbPath) as DbWithTransaction;
dbInstance.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
`);

// Add a transaction wrapper similar to better-sqlite3
const transaction = <T>(fn: () => T): (() => T) => {
  return () => {
    dbInstance.exec('BEGIN');
    try {
      const res = fn();
      dbInstance.exec('COMMIT');
      return res;
    } catch (e) {
      dbInstance.exec('ROLLBACK');
      throw e;
    }
  };
};

dbInstance.transaction = transaction;

export const db = dbInstance;

const schema = fs.readFileSync(schemaPath, "utf-8");
db.exec(schema);

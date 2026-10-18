import Database from "better-sqlite3";
import crypto from "crypto";

function normalizeForHash(input: string) {
  return (input || "")
    .replace(/\sdata-pid="[^"]*"/g, "")
    .replace(/\sdata-original-token="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

const db = new Database("../../data/app.db");

const rows = db.prepare("SELECT pk, content_md, content_html, excerpt FROM contents").all() as any[];
let updated = 0;

for (const row of rows) {
  const newHash = sha256(normalizeForHash(row.content_md || row.content_html || row.excerpt || ""));
  db.prepare("UPDATE contents SET content_hash = ? WHERE pk = ?").run(newHash, row.pk);
  updated++;
}

console.log(`Updated ${updated} hashes in contents.`);

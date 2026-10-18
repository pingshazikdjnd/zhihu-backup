import sqlite3
import hashlib
import re

def normalize_for_hash(input_text):
    if not input_text:
        return ""
    # strip data-pid="xxx"
    input_text = re.sub(r'\sdata-pid="[^"]*"', '', input_text)
    # strip data-original-token="xxx"
    input_text = re.sub(r'\sdata-original-token="[^"]*"', '', input_text)
    # normalize spaces
    input_text = re.sub(r'\s+', ' ', input_text).strip()
    return input_text

def sha256(input_text):
    return hashlib.sha256(input_text.encode('utf-8')).hexdigest()

conn = sqlite3.connect('data/app.db')
cursor = conn.cursor()

cursor.execute("SELECT pk, content_md, content_html, excerpt FROM contents")
rows = cursor.fetchall()
updated = 0

for row in rows:
    pk, content_md, content_html, excerpt = row
    text_to_hash = content_md or content_html or excerpt or ""
    new_hash = sha256(normalize_for_hash(text_to_hash))
    cursor.execute("UPDATE contents SET content_hash = ? WHERE pk = ?", (new_hash, pk))
    updated += 1

conn.commit()
conn.close()
print(f"Updated {updated} hashes in contents.")

import os

def process(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace("export function", "export async function")
    content = content.replace("db.prepare(", "await db.prepare(")
    content = content.replace("emitChange(", "await emitChange(")
    content = content.replace("db.transaction(() => {", "await db.transaction(async () => {")
    content = content.replace("return tx();", "return;") # Fix later manually
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

process(r"g:\gemini zhihu\apps\worker\src\services\contents.ts")
process(r"g:\gemini zhihu\apps\worker\src\services\collections.ts")

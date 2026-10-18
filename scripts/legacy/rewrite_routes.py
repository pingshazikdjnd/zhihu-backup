import os
import re

def process(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    content = re.sub(r'(get|post|delete)\(("[^"]+"), (c =>)', r'\1(\2, async \3', content)
    
    funcs = ['getContentDetail', 'listContents', 'listComments', 'replaceComments', 'upsertContent', 'emitChange', 'upsertCollectionSnapshot', 'listCollections', 'listAllCollectionItems', 'getCollectionDetail', 'upsertUpvote', 'listUpvotes']
    
    for fn in funcs:
        # Instead of complex lookbehind, just simple replace
        content = content.replace(f" {fn}(", f" await {fn}(")
        content = content.replace(f"({fn}(", f"(await {fn}(")
        content = content.replace(f"return {fn}(", f"return await {fn}(")
        content = content.replace(f"await await {fn}(", f"await {fn}(")

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

for root, _, files in os.walk(r'g:\gemini zhihu\apps\worker\src\routes'):
    for file in files:
        if file.endswith('.ts'):
            process(os.path.join(root, file))

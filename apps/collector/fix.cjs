const fs = require('fs');
let content = fs.readFileSync('apps/collector/src/jobs/sync.ts', 'utf8');

const anchor = '           console.log(`✅ 收藏夹 [${coll.title}] 快照保存成功: ${res.added} 新增, ${res.removed} 移除。共 ${res.count} 项`);\n        } catch (e: any) {\n\n    for (const item of json.data) {';

if (content.includes(anchor)) {
  const replacement = `           console.log(\`✅ 收藏夹 [\${coll.title}] 快照保存成功: \${res.added} 新增, \${res.removed} 移除。共 \${res.count} 项\`);
        } catch (e: any) {
           console.error(\`❌ 收藏夹保存失败: \${e.message}\`);
        }
      } else {
        console.log(\`⚠️ 收藏夹 [\${coll.title}] 为空或未抓取到条目\`);
      }
    }
  }

  console.log("🎉 收藏夹同步完成！");
  await browser.close();
}

export async function runUpvotesScraper() {
  const browser = await setupBrowser();
  console.log("🚀 开始同步你的赞同记录...");
  
  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  let nextUrl = \`https://www.zhihu.com/api/v3/moments/\${ZHIHU_USERNAME}/activities?limit=20\`;
  let isEnd = false;
  let count = 0;

  while (!isEnd && nextUrl) {
    const res = await context.request.get(nextUrl);
    if (!res.ok()) {
      console.error(\`❌ 获取动态失败: API 返回状态码 \${res.status()}\`);
      break;
    }
    const json = await res.json();
    if (!json.data || json.data.length === 0) break;

    for (const item of json.data) {`;

  content = content.replace(anchor, replacement);
  fs.writeFileSync('apps/collector/src/jobs/sync.ts', content);
  console.log('Fixed sync.ts');
} else {
  console.log('Anchor not found');
}

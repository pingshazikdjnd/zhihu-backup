require('dotenv').config({path: '../../.env'});
const { chromium } = require('playwright');
async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const cookies = process.env.ZHIHU_COOKIE_STRING.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const [name, ...rest] = pair.split('=');
    return { name: name.trim(), value: rest.join('=').trim(), domain: '.zhihu.com', path: '/' };
  });
  await context.addCookies(cookies);
  const res = await context.request.get(`https://www.zhihu.com/api/v4/collections/822239827/items?limit=1&offset=0`);
  const json = await res.json();
  if (json.data && json.data.length > 0) {
      console.log('keys:', Object.keys(json.data[0].content));
      console.log('has content?', !!json.data[0].content.content);
      console.log('voteup_count?', json.data[0].content.voteup_count);
  }
  await browser.close();
}
main();

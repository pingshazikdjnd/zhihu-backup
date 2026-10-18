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
  const res = await context.request.get(`https://www.zhihu.com/api/v3/moments/${process.env.ZHIHU_USERNAME}/activities?limit=10`);
  console.log('Activities status:', res.status());
  if (res.ok()) {
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
  }
  await browser.close();
}
main();

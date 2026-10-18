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
  
  const endpoints = [
    `/api/v4/members/${process.env.ZHIHU_USERNAME}/activities`,
    `/api/v4/members/${process.env.ZHIHU_USERNAME}/voteups`,
    `/api/v4/members/${process.env.ZHIHU_USERNAME}/agrees`
  ];
  
  for (const ep of endpoints) {
      console.log(`Testing ${ep}...`);
      const res = await context.request.get(`https://www.zhihu.com${ep}`);
      console.log('Status:', res.status());
      if (res.ok()) {
         const json = await res.json();
         if (json.data && json.data.length > 0) {
             console.log('Keys of first item:', Object.keys(json.data[0]));
             if (json.data[0].target) console.log('Target type:', json.data[0].target.type);
         } else {
             console.log('Empty data array');
         }
      }
  }
  await browser.close();
}
main();

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
  const includeStr = encodeURIComponent('data[*].is_normal,admin_closed_comment,reward_info,is_collapsed,annotation_action,annotation_detail,collapse_reason,collapsed_by,suggest_edit,comment_count,can_comment,content,voteup_count,reshipment_settings,comment_permission,mark_infos,created_time,updated_time,review_info,question,excerpt,is_labeled,label_info,relationship.is_authorized,voting,is_author,is_thanked,is_nothelp,is_recognized;data[*].author.badge[?(type=best_answerer)].topics');
  const res = await context.request.get(`https://www.zhihu.com/api/v4/members/${process.env.ZHIHU_USERNAME}/answers?include=${includeStr}&limit=1&offset=0`);
  const json = await res.json();
  const item = json.data[0];
  console.log('reaction:', item.reaction);
  console.log('voting:', item.voting);
  console.log('voteup_count:', item.voteup_count);
  await browser.close();
}
main();

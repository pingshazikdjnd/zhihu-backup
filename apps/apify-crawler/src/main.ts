import { Actor, log } from "apify";
import { chromium } from "playwright";

interface InputSchema {
    runType: "all" | "answers" | "collections" | "upvotes";
    isFast: boolean;
    apiUrl: string;
    apiSecret?: string;
    zhihuUsername: string;
    cookieString: string;
}

await Actor.init();
const input = await Actor.getInput<InputSchema>();
if (!input) throw new Error("Missing input");
const { runType, isFast, apiUrl, apiSecret, zhihuUsername, cookieString } = input;

async function post(path: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiSecret) headers["authorization"] = `Bearer ${apiSecret}`;
  
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const sendContent = (b: any) => post("/ingest/content", b);
const sendComments = (b: any) => post("/ingest/comments", b);
const sendCollectionSnapshot = (b: any) => post("/ingest/collection-snapshot", b);


const ZHIHU_USERNAME = zhihuUsername;
const ZHIHU_COOKIE_STRING = cookieString;
const ZHIHU_COOKIE_Z_C0 = undefined;

async function setupBrowser() {
  return chromium.launch({ headless: true });
}

function getCookiesArray() {
  const cookies: Array<{name: string, value: string, domain: string, path: string}> = [];
  
  // 如果用户粘贴了全量 Cookie 字符串，自动拆解
  if (ZHIHU_COOKIE_STRING) {
    const pairs = ZHIHU_COOKIE_STRING.split(";").map(s => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const [name, ...rest] = pair.split("=");
      cookies.push({
        name: name.trim(),
        value: rest.join("=").trim(),
        domain: ".zhihu.com",
        path: "/"
      });
    }
  } else if (ZHIHU_COOKIE_Z_C0) {
    // 兼容只填了 z_c0 的情况
    cookies.push({ name: "z_c0", value: ZHIHU_COOKIE_Z_C0, domain: ".zhihu.com", path: "/" });
  }
  
  return cookies;
}

function cleanHtml(html: any) {
  if (typeof html !== "string") return "";
  let cleaned = html.replace(/<img([^>]*)>/g, (match, attrs) => {
     const realSrc = attrs.match(/data-(?:original|actualsrc)="([^"]+)"/);
     if (!realSrc) return match;
     const src = realSrc[1];
     // 懒加载图常见 src="" 或没有 src 属性，原来的 replace 匹配不到非空 src，
     // 结果 data-original 被后端清洗器剥掉、图片永久空白。
     if (/src="[^"]*"/.test(attrs)) {
        return `<img${attrs.replace(/src="[^"]*"/, `src="${src}"`)}>`;
     }
     return `<img${attrs} src="${src}">`;
  });
  // Remove data-pid to prevent spurious text updates
  cleaned = cleaned.replace(/\sdata-pid="[^"]*"/g, "");
  return cleaned;
}

export async function runScraper() {
  const browser = await setupBrowser();
  console.log("🚀 开始知乎回答自动同步...");
  
  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  const pendingCommentsQueue: Array<{ answerId: string; url: string }> = [];

  let offset = 0;
  let isEnd = false;
  let existingCount = 0;
  
  console.log("🌐 正在通过 API 拉取回答列表...");
  const includeStr = encodeURIComponent("data[*].is_normal,admin_closed_comment,reward_info,is_collapsed,annotation_action,annotation_detail,collapse_reason,collapsed_by,suggest_edit,comment_count,can_comment,content,voteup_count,reshipment_settings,comment_permission,mark_infos,created_time,updated_time,review_info,question,excerpt,is_labeled,label_info,relationship.is_authorized,voting,is_author,is_thanked,is_nothelp,is_recognized,visit_count,favorite_count;data[*].author.badge[?(type=best_answerer)].topics");

  while (!isEnd) {
    const res = await context.request.get(`https://www.zhihu.com/api/v4/members/${ZHIHU_USERNAME}/answers?include=${includeStr}&limit=20&offset=${offset}`);
    
    if (!res.ok()) {
      console.error(`❌ 获取回答失败: API 返回状态码 ${res.status()}`);
      break;
    }
    
    const json = await res.json();
    if (!json.data || json.data.length === 0) {
      // 回答列表没有删除检测，空页不会误删；但被风控时静默漏抓，
      // 至少要让日志能看出来本轮结果不完整。
      if (!json.paging?.is_end) {
        console.warn("⚠️ 回答列表返回空页但未到末尾，可能被风控，本轮结果不完整");
      }
      break;
    }

    for (const item of json.data) {
      if (item.type !== "answer") continue;

      let finalVoteup = item.voteup_count || item.reaction?.statistics?.like_count || item.reaction?.statistics?.upvote_count || 0;
      let finalFavorite = item.favorite_count || item.thanks_count || item.reaction?.statistics?.favorites || item.reaction?.statistics?.favorite_count || 0;
      let finalVisit = item.visit_count || item.reaction?.statistics?.visit_count || 0;
      
      // Fetch detailed stats because list API omits them
      try {
         const detailRes = await context.request.get(`https://www.zhihu.com/api/v4/answers/${item.id}?include=voteup_count,comment_count,visit_count,favorite_count`);
         if (detailRes.ok()) {
            const detail = await detailRes.json();
            if (detail.voteup_count !== undefined) finalVoteup = detail.voteup_count;
            if (detail.favorite_count !== undefined) finalFavorite = detail.favorite_count;
            if (detail.visit_count !== undefined) finalVisit = detail.visit_count;
         }
      } catch (e) {
         console.error(`Failed to fetch detail for ${item.id}`);
      }

      const contentInput = {
        sourceType: "answer" as const,
        sourceId: String(item.id),
        title: item.question?.title || "未知问题",
        sourceUrl: `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`,
        author: { name: item.author?.name, urlToken: item.author?.url_token, avatarUrl: item.author?.avatar_url, headline: item.author?.headline },
        question: { id: String(item.question?.id), title: item.question?.title },
        contentHtml: cleanHtml(item.content),
        contentMd: "",
        excerpt: item.excerpt || "",
        voteupCount: finalVoteup,
        commentCount: item.comment_count || 0,
        favoriteCount: finalFavorite,
        visitCount: finalVisit,
        isCollapsed: item.is_collapsed,
        isLabeled: item.is_labeled,
        labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
        createdTime: new Date((item.created_time || 0) * 1000).toISOString(),
        updatedTime: new Date((item.updated_time || 0) * 1000).toISOString()
      };

      try {
        const dbRes = await sendContent(contentInput);
        console.log(`✅ 保存回答: ${contentInput.title}`);
        
        if (!dbRes.created && !dbRes.changed) {
          existingCount++;
          if (existingCount >= 20 && isFast) {
            console.log("🛑 连续20个条目无更新，停止本轮极速同步。");
            isEnd = true;
            break;
          }
        } else {
          existingCount = 0;
        }
        
        if (contentInput.commentCount > 0 && contentInput.commentCount > (dbRes.prevCommentCount || 0)) {
          console.log(`💬 发现新评论 (${dbRes.prevCommentCount} -> ${contentInput.commentCount})，加入抓取队列`);
          pendingCommentsQueue.push({ answerId: String(item.id), url: contentInput.sourceUrl });
        }
      } catch (err: any) {
        console.error(`❌ 保存回答失败: ${err.message}`);
      }
    }

    if (!isEnd) isEnd = json.paging?.is_end;
    offset += 20;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (pendingCommentsQueue.length > 0) {
    console.log(`💬 正在抓取 ${pendingCommentsQueue.length} 篇回答的评论...`);
    for (const task of pendingCommentsQueue) {
      let cOffset = 0;
      let cIsEnd = false;
      let cIncomplete = false;
      const allComments: any[] = [];
      
      while (!cIsEnd) {
        const cRes = await context.request.get(`https://www.zhihu.com/api/v4/answers/${task.answerId}/root_comments?limit=20&offset=${cOffset}`);
        if (!cRes.ok()) { cIncomplete = true; break; }
        
        const cJson = await cRes.json();
        // 知乎风控会返回 200 + 空数组。只有 paging.is_end 为真才算真的抓完，
        // 否则必须标记不完整 —— 不然服务端会把没抓到的评论全部判为已删除。
        if (!cJson.data || cJson.data.length === 0) {
          if (!cJson.paging?.is_end) cIncomplete = true;
          break;
        }
        
        for (const c of cJson.data) {
          allComments.push({
            id: String(c.id),
            parentId: c.reply_to_comment_id ? String(c.reply_to_comment_id) : null,
            author: c.author?.member?.name || "匿名",
            authorAvatar: c.author?.member?.avatar_url || "",
            beReplied: c.reply_to_author?.member?.name || null,
            content: cleanHtml(c.content),
            img: "",
            time: new Date((c.created_time || 0) * 1000).toISOString(),
            location: c.address_text || "",
            likes: c.vote_count || c.reaction?.statistics?.like_count || 0,
            isAuthor: c.is_author === true || c.is_author === 1 || c.author?.role === "author",
            isTop: c.top === true || c.top === 1,
            isFeatured: c.featured === true || c.featured === 1
          });
          
          if (c.child_comment_count > (c.child_comments?.length || 0)) {
            let chOffset = 0;
            let chIsEnd = false;
              while (!chIsEnd) {
                // 必须复用带 cookie 的 context.request：裸 fetch 不带登录态，知乎直接 401，
                // 结果就是该回答的评论永远同步不了。
                const chRes = await context.request.get(`https://www.zhihu.com/api/v4/comments/${c.id}/child_comments?limit=20&offset=${chOffset}`);
                if (!chRes.ok()) { cIncomplete = true; break; }
                const chJson = await chRes.json();
                if (!chJson.data || chJson.data.length === 0) {
                  if (!chJson.paging?.is_end) cIncomplete = true;
                  break;
                }
                
                for (const child of chJson.data) {
                allComments.push({
                 id: String(child.id),
                 parentId: String(c.id),
                 author: child.author?.member?.name || "匿名",
                 authorAvatar: child.author?.member?.avatar_url || "",
                 beReplied: child.reply_to_author?.member?.name || null,
                 content: cleanHtml(child.content),
                 img: "",
                 time: new Date((child.created_time || 0) * 1000).toISOString(),
                 location: child.address_text || "",
                 likes: child.vote_count || child.reaction?.statistics?.like_count || 0,
                 isAuthor: child.is_author === true || child.is_author === 1 || child.author?.role === "author",
                 isTop: child.top === true || child.top === 1,
                 isFeatured: child.featured === true || child.featured === 1
                });
              }
              chIsEnd = chJson.paging?.is_end;
              chOffset += 20;
              await new Promise(r => setTimeout(r, 300));
            }
          } else if (c.child_comments && c.child_comments.length > 0) {
            for (const child of c.child_comments) {
               allComments.push({
                 id: String(child.id),
                 parentId: String(c.id),
                 author: child.author?.member?.name || "匿名",
                 authorAvatar: child.author?.member?.avatar_url || "",
                 beReplied: child.reply_to_author?.member?.name || null,
                 content: cleanHtml(child.content),
                 img: "",
                 time: new Date((child.created_time || 0) * 1000).toISOString(),
                 location: child.address_text || "",
                 likes: child.vote_count || child.reaction?.statistics?.like_count || 0,
                 isAuthor: child.is_author === true || child.is_author === 1 || child.author?.role === "author",
                 isTop: child.top === true || child.top === 1,
                 isFeatured: child.featured === true || child.featured === 1
               });
            }
          }
        }
        
        cIsEnd = cJson.paging?.is_end;
        cOffset += 20;
        await new Promise(r => setTimeout(r, 500));
      }
      
      if (allComments.length > 0) {
        try {
          // 有数据就提交，用 partial 告诉服务端「本轮不完整，跳过删除检测」。
          // 之前 cIncomplete 时整轮不提交，已抓到的更新也一起丢了。
          await sendComments({ contentPk: `answer:${task.answerId}`, comments: allComments, partial: cIncomplete });
          console.log(`✅ 保存评论: ${allComments.length} 条 (回答 ID: ${task.answerId})${cIncomplete ? " [partial]" : ""}`);
        } catch (err: any) {
           console.error(`❌ 保存评论失败: ${err.message}`);
        }
      } else if (cIncomplete) {
        console.warn(`⚠️ 回答 ${task.answerId} 评论抓取中断且无数据，跳过本轮提交`);
      }
    }
  }

  console.log("🎉 回答和评论同步完成！");
  await browser.close();
}

export async function runCollectionScraper() {
  const browser = await setupBrowser();
  console.log("🚀 开始知乎收藏夹自动同步...");
  
  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  const foundCollections: Array<{ id: string; title: string; updatedTime?: string }> = [];
  
  console.log("🌐 正在通过 API 获取收藏夹列表...");
  let offset = 0;
  let isEnd = false;
  
  while (!isEnd) {
    const res = await context.request.get(`https://www.zhihu.com/api/v4/members/${ZHIHU_USERNAME}/favlists?limit=20&offset=${offset}`);
    if (!res.ok()) {
       console.error(`❌ 获取收藏夹列表失败: API 返回状态码 ${res.status()}`);
       break;
    }
    const json = await res.json();
    if (!json.data || json.data.length === 0) break;
    
    for (const item of json.data) {
       if (item.id && item.title) {
         const updatedTime = item.updated_time ? new Date(item.updated_time * 1000).toISOString() : undefined;
         foundCollections.push({ id: String(item.id), title: item.title, updatedTime });
         console.log(`👀 发现收藏夹: ${item.title}`);
       }
    }
    
    if (!isEnd) isEnd = json.paging?.is_end;
    offset += 20;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (foundCollections.length > 0) {
    console.log(`📥 开始抓取 ${foundCollections.length} 个收藏夹的条目...`);
    const collIncludeStr = encodeURIComponent("data[*].content.is_normal,admin_closed_comment,reward_info,is_collapsed,annotation_action,annotation_detail,collapse_reason,collapsed_by,suggest_edit,comment_count,can_comment,content,voteup_count,reshipment_settings,comment_permission,mark_infos,created_time,updated_time,review_info,question,excerpt,is_labeled,label_info,relationship.is_authorized,voting,is_author,is_thanked,is_nothelp,is_recognized,visit_count,favorite_count;data[*].content.author.badge[?(type=best_answerer)].topics");
    
    for (const coll of foundCollections) {
      console.log(`-> 正在抓取收藏夹: ${coll.title}`);
      
      const items: any[] = [];
      let cOffset = 0;
      let cIsEnd = false;
      let existingCount = 0;
      let cIncomplete = false;

      while (!cIsEnd) {
         const cRes = await context.request.get(`https://www.zhihu.com/api/v4/collections/${coll.id}/items?include=${collIncludeStr}&limit=20&offset=${cOffset}`);
         if (!cRes.ok()) { cIncomplete = true; break; }
         
         const cJson = await cRes.json();
         // 同上：空数组不等于翻页结束，未到 is_end 时标记不完整。
         // 否则 cIsEnd 保持 false、cIncomplete 也保持 false，
         // incremental 会被算成 false，服务端就把未出现的条目全部标记移除。
         if (!cJson.data || cJson.data.length === 0) {
           if (!cJson.paging?.is_end) cIncomplete = true;
           break;
         }
         
         for (const row of cJson.data) {
            const item = row.content;
            if (!item || !item.type) continue;
            
            const sourceType = item.type === "answer" ? "answer" : (item.type === "article" ? "article" : "pin");
            // pin/article 的 item.url 可能为空，构造兜底 URL，避免 zod .url() 拒绝整个快照
            const sourceUrl = item.type === "answer"
                 ? `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`
                 : item.url || (item.type === "article" ? `https://zhuanlan.zhihu.com/p/${item.id}` : `https://www.zhihu.com/pin/${item.id}`);
            const title = item.question?.title || item.title || "无标题";
            
            // 如果拉到了内容，同时把它存进 contents 表供用户阅读
            if (item.content) {
              const contentInput = {
                sourceType: item.type as "answer" | "article" | "pin",
                sourceId: String(item.id),
                title,
                sourceUrl,
                author: { name: item.author?.name, urlToken: item.author?.url_token, avatarUrl: item.author?.avatar_url, headline: item.author?.headline },
                question: item.question ? { id: String(item.question.id), title: item.question.title } : undefined,
                contentHtml: cleanHtml(item.content),
                contentMd: "",
                excerpt: item.excerpt || "",
                voteupCount: item.voteup_count || item.reaction?.statistics?.like_count || item.reaction?.statistics?.upvote_count || 0,
                commentCount: item.comment_count || 0,
                favoriteCount: item.favorite_count || item.thanks_count || item.reaction?.statistics?.favorites || item.reaction?.statistics?.favorite_count || 0,
                visitCount: item.visit_count || item.reaction?.statistics?.visit_count || 0,
                isCollapsed: item.is_collapsed,
                isLabeled: item.is_labeled,
                labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
                createdTime: new Date((item.created_time || 0) * 1000).toISOString(),
                updatedTime: new Date((item.updated_time || 0) * 1000).toISOString()
              };
              try {
                const dbRes = await sendContent(contentInput);
                if (!dbRes.created && !dbRes.changed) {
                  existingCount++;
                  if (existingCount >= 20 && isFast) {
                    console.log("🛑 连续20个收藏条目无更新，停止本收藏夹的极速同步。");
                    cIsEnd = true;
                    break;
                  }
                } else {
                  existingCount = 0;
                }
              } catch(e) {}
            }

            items.push({
               sourceType,
               sourceId: String(item.id),
               title,
               authorName: item.author?.name || "匿名",
               sourceUrl
            });
         }
         
         if (!cIsEnd) cIsEnd = cJson.paging?.is_end;
         cOffset += 20;
         await new Promise(r => setTimeout(r, 500));
      }
      
      if (items.length > 0) {
        try {
          await sendCollectionSnapshot({
            collection: { id: coll.id, title: coll.title, ownerToken: ZHIHU_USERNAME || "", updatedTime: coll.updatedTime },
            // 抓取中断时必须跳过移除检测，防止把未抓到的条目误标移除
            incremental: cIncomplete || (cIsEnd && isFast),
            items
          });
        } catch (e: any) {
           console.error(`❌ 收藏夹保存失败: ${e.message}`);
        }
      } else {
        console.log(`⚠️ 收藏夹 [${coll.title}] 为空或未抓取到条目`);
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

  let nextUrl = `https://www.zhihu.com/api/v3/moments/${ZHIHU_USERNAME}/activities?limit=20`;
  let isEnd = false;
  let count = 0;
  let existingCount = 0;

  while (!isEnd && nextUrl) {
    const res = await context.request.get(nextUrl);
    if (!res.ok()) {
      console.error(`❌ 获取动态失败: API 返回状态码 ${res.status()}`);
      break;
    }
    const json = await res.json();
    if (!json.data || json.data.length === 0) {
      if (!json.paging?.is_end) {
        console.warn("⚠️ 赞同列表返回空页但未到末尾，可能被风控，本轮结果不完整");
      }
      break;
    }

    for (const item of json.data) {
      if (!item.action_text || !item.action_text.includes("赞同")) continue;
      
      const target = item.target;
      if (!target || !target.id) continue;

      let sourceType: "answer" | "article" | "pin";
      let sourceId = String(target.id);
      let title = "";
      let sourceUrl = "";
      
      if (target.type === "answer") {
        sourceType = "answer";
        title = target.question?.title || "未知问题";
        sourceUrl = `https://www.zhihu.com/question/${target.question?.id}/answer/${target.id}`;
      } else if (target.type === "article") {
        sourceType = "article";
        title = target.title || "未知文章";
        sourceUrl = `https://zhuanlan.zhihu.com/p/${target.id}`;
      } else {
        continue; // skip other types for now
      }

      const voteupCount = target.voteup_count || target.reaction?.statistics?.like_count || 0;
      
      const contentInput = {
        sourceType,
        sourceId,
        title,
        sourceUrl,
        author: { name: target.author?.name, urlToken: target.author?.url_token, avatarUrl: target.author?.avatar_url, headline: target.author?.headline },
        question: target.question ? { id: String(target.question.id), title: target.question.title } : undefined,
        contentHtml: cleanHtml(target.content),
        contentMd: "",
        excerpt: target.excerpt || "",
        voteupCount,
        commentCount: target.comment_count || 0,
        favoriteCount: target.favorite_count || target.thanks_count || target.reaction?.statistics?.favorites || target.reaction?.statistics?.favorite_count || 0,
        visitCount: target.visit_count || target.reaction?.statistics?.visit_count || 0,
        isCollapsed: target.is_collapsed,
        isLabeled: target.is_labeled,
        labelInfo: target.label_info ? JSON.stringify(target.label_info) : "",
        createdTime: new Date((target.created_time || 0) * 1000).toISOString(),
        updatedTime: new Date((target.updated_time || 0) * 1000).toISOString()
      };

      try {
        const pk = await sendContent(contentInput);
        if (pk) {
           const upvoteTime = new Date((item.created_time || 0) * 1000).toISOString();
           const upRes = await post(`/ingest/upvote`, { contentPk: pk.pk, upvoteTime });
           count++;
           
           if (!upRes.created) {
             existingCount++;
             if (existingCount >= 20 && isFast) {
               console.log("🛑 连续20个赞同记录无更新，停止本轮极速同步。");
               isEnd = true;
               break;
             }
           } else {
             existingCount = 0;
           }
        }
      } catch (err: any) {
        console.error(`❌ 保存赞同失败: ${title}`, err.message);
      }
    }

    console.log(`💬 已拉取并保存 ${count} 条赞同记录...`);

    if (!isEnd) isEnd = json.paging?.is_end;
    nextUrl = json.paging?.next;
    
    if (json.data.length === 0) break;
  }

  await browser.close();
  console.log("🎉 赞同同步完成！");
}


// --- Apify Entry Point ---
try {
  if (runType === "all" || runType === "answers") {
    await runScraper();
  }
  if (runType === "all" || runType === "collections") {
    // Note: The original export is runCollectionScraper
    if (typeof runCollectionScraper === "function") {
      await runCollectionScraper();
    }
  }
  if (runType === "all" || runType === "upvotes") {
    if (typeof runUpvotesScraper === "function") {
      await runUpvotesScraper();
    }
  }
} catch (e: any) {
  log.error(e.message || String(e));
} finally {
  await Actor.exit();
}

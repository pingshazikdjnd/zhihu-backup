import { Actor, log } from "apify";
import { chromium } from "playwright";

interface InputSchema {
    runType: "all" | "answers" | "collections" | "upvotes";
    isFast: boolean;
    apiUrl: string;
    apiSecret?: string;
    zhihuUsername: string;
    cookieString: string;
    /** 赞同段断点游标（moments 的 paging.next）：从上次中断处继续补历史 */
    upvotesCursor?: string;
}

await Actor.init();
const input = await Actor.getInput<InputSchema>();
if (!input) throw new Error("Missing input");
const { runType, isFast, apiUrl, apiSecret, zhihuUsername, cookieString, upvotesCursor } = input;

// 失败上报：所有异常都被吞掉的爬虫在 Apify 上永远显示 SUCCEEDED，
// cookie 失效后零数据入库也毫无感知。这里集中统计，结束时据此决定 run 状态。
const stats = { saved: 0, failed: 0, authRejected: 0, riskEmpty: 0 };

async function post(path: string, body: unknown): Promise<any> {
  // apiUrl 尾斜杠归一，避免拼出 //ingest/content 的 404
  const base = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiSecret) headers["authorization"] = `Bearer ${apiSecret}`;

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    stats.failed++;
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  // 成功计数放在 JSON 解析之后：200+非 JSON 体时避免 saved/failed 双计
  const json = await res.json();
  stats.saved++;
  return json;
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

// 已知内容类型：收藏夹里会出现 zvideo 等未知类型，直接透传会被服务端
// zod enum 拒掉（400），映射到 pin 又会写出错误的 URL——两处必须用同一映射
const KNOWN_TYPES = new Set(["answer", "article", "pin"]);

// 秒级时间戳转 ISO；缺失时返回空串而不是 1970-01-01 哨兵
// （哨兵入库会污染排序，服务端也会把 1970 视为无效值回退旧数据）
const toIsoOrNull = (sec?: number) => (sec ? new Date(sec * 1000).toISOString() : "");

function getCookiesArray() {
  const cookies: Array<{name: string, value: string, domain: string, path: string}> = [];

  // 如果用户粘贴了全量 Cookie 字符串，自动拆解。
  // 逐条过滤而不是整串直接交给 addCookies：Playwright 遇到含控制字符
  // （换行粘贴很常见）的值或 __Host-/__Secure- 前缀（要求 secure:true）
  // 会直接 throw，一条脏 cookie 就炸掉整轮抓取。
  if (ZHIHU_COOKIE_STRING) {
    const pairs = ZHIHU_COOKIE_STRING.split(";").map(s => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/[\x00-\x1f\x7f]/.test(value) || name.startsWith("__Host-") || name.startsWith("__Secure-")) continue;
      cookies.push({ name, value, domain: ".zhihu.com", path: "/" });
    }
  } else if (ZHIHU_COOKIE_Z_C0) {
    // 兼容只填了 z_c0 的情况
    cookies.push({ name: "z_c0", value: ZHIHU_COOKIE_Z_C0, domain: ".zhihu.com", path: "/" });
  }

  if (cookies.length === 0) {
    throw new Error("cookieString 里没有可用的知乎 cookie（解析结果为空）");
  }
  return cookies;
}

function cleanHtml(html: any) {
  if (typeof html !== "string") return "";
  let cleaned = html.replace(/<img([^>]*)>/g, (match, attrs) => {
     const realSrc = attrs.match(/data-(?:original|actualsrc)="([^"]+)"/);
     if (!realSrc) return match;
     const src = realSrc[1];
      // 懒加载图常见 src="" 或没有 src 属性；注意 \s 前缀——不带的话正则会
      // 误配到 data-actualsrc 属性名内部的 "src="，替换错位置后图片仍空白
      if (/\ssrc="[^"]*"/.test(attrs)) {
        return `<img${attrs.replace(/\ssrc="[^"]*"/, ` src="${src}"`)}>`;
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
      if (res.status() === 401 || res.status() === 403) stats.authRejected++;
      else stats.failed++; // 中途 429/5xx 也计入终态，不再静默截断
      break;
    }
    
    const json = await res.json();
    if (!json.data || json.data.length === 0) {
      // 回答列表没有删除检测，空页不会误删；但被风控时静默漏抓，
      // 至少要让日志能看出来本轮结果不完整。
      if (!json.paging?.is_end) {
        // 计入终态判定：风控空页 + 零成功同样要把 run 标失败
        stats.riskEmpty++;
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
        createdTime: toIsoOrNull(item.created_time),
        updatedTime: toIsoOrNull(item.updated_time)
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
        stats.failed++;
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
            time: toIsoOrNull(c.created_time),
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
                 time: toIsoOrNull(child.created_time),
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
                 time: toIsoOrNull(child.created_time),
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
          // 知乎按点赞序 + offset 分页，抓取期间点赞变化会让同一条评论漂移到
          // 相邻页：重复 id 不去掉会在服务端撞主键、整批失败（服务端也有同样去重）
          const uniqueMap = new Map(allComments.map(c => [c.id, c] as const));
          const finalComments = [...uniqueMap.values()];
          // 分批提交：热榜回答动辄数千评论，单请求会撞 Workers 子请求限制。
          // 中间批 partial=true（跳过删除对账），最后一批带全量 allIds 供对账，
          // 否则前面批次刚插入的评论会被误判删除
          const CHUNK = 500;
          for (let i = 0; i < finalComments.length; i += CHUNK) {
            const isLast = i + CHUNK >= finalComments.length;
            const payload = {
              contentPk: `answer:${task.answerId}`,
              comments: finalComments.slice(i, i + CHUNK),
              partial: isLast ? cIncomplete : true,
              ...(isLast ? { allIds: finalComments.map(c => c.id) } : {})
            };
            try {
              await sendComments(payload);
            } catch (e: any) {
              // 瞬时失败重试一次：分批一旦断在中间，content 的 comment_count 已是
              // 全量值，下轮不会再进评论抓取队列，缺口会挂到该回答有新评论为止。
              // 幂等可重发：已入库批次会被 replaceComments 识别为 UPDATE
              console.warn(`⚠️ 评论批次失败，重试一次 (第 ${Math.floor(i / CHUNK) + 1} 批): ${e?.message || e}`);
              await sendComments(payload);
            }
          }
          console.log(`✅ 保存评论: ${allComments.length} 条 (回答 ID: ${task.answerId})${cIncomplete ? " [partial]" : ""}`);
        } catch (err: any) {
           stats.failed++;
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
       if (res.status() === 401 || res.status() === 403) stats.authRejected++;
      else stats.failed++; // 中途 429/5xx 也计入终态，不再静默截断
       break;
    }
    const json = await res.json();
    // 与 answers/upvotes 对齐：空页且未到 is_end 是风控信号，计入终态判定，
    // 否则收藏夹定向风控时 run 依然全绿、收藏静默停止更新
    if (!json.data || json.data.length === 0) {
      if (!json.paging?.is_end) {
        stats.riskEmpty++;
        console.warn("⚠️ 收藏夹列表返回空页但未到末尾，可能被风控，本轮结果不完整");
      }
      break;
    }
    
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
         if (!cRes.ok()) {
           // 与三个成员级列表端点对齐：失败计入终态统计（此前只标 cIncomplete，
           // items 接口被单独风控时 run 依然全绿）
           if (cRes.status() === 401 || cRes.status() === 403) stats.authRejected++;
           else stats.failed++;
           cIncomplete = true;
           break;
         }

         const cJson = await cRes.json();
         // 同上：空数组不等于翻页结束，未到 is_end 时标记不完整。
         // 否则 cIsEnd 保持 false、cIncomplete 也保持 false，
         // incremental 会被算成 false，服务端就把未出现的条目全部标记移除。
         if (!cJson.data || cJson.data.length === 0) {
           if (!cJson.paging?.is_end) {
             stats.riskEmpty++;
             console.warn(`⚠️ 收藏夹 [${coll.title}] 条目返回空页但未到末尾，可能被风控`);
             cIncomplete = true;
           }
           break;
         }
         
         for (const row of cJson.data) {
            const item = row.content;
            if (!item || !item.type) continue;

            const sourceType = KNOWN_TYPES.has(item.type) ? item.type : "pin";
            // item.url 可能为空串或相对路径，zod .url() 会拒掉整个快照（不是丢一条）。
            // 拼接 URL 永远语法合法，item.url 仅在通过 URL 校验时才采用。
            const fallbackUrl = item.type === "answer"
                 ? `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`
                 : item.type === "article" ? `https://zhuanlan.zhihu.com/p/${item.id}` : `https://www.zhihu.com/pin/${item.id}`;
            let sourceUrl = fallbackUrl;
            if (typeof item.url === "string" && item.url) {
              try {
                const u = new URL(item.url);
                if (u.protocol === "http:" || u.protocol === "https:") sourceUrl = item.url;
              } catch { /* item.url 非法则用拼接值 */ }
            }
            const title = item.question?.title || item.title || "无标题";

            // 如果拉到了内容，同时把它存进 contents 表供用户阅读。
            // 未知类型（zvideo 等）不透传：服务端 enum 会拒，写进去的数据也是错的
            if (item.content && KNOWN_TYPES.has(item.type)) {
              // pin 的 content 是块数组 [{type:"text",content:"..."}] 而非 HTML 字符串，
              // 直接给 cleanHtml 会因非字符串返回空串——想法正文就全丢了
              const rawContent = Array.isArray(item.content)
                ? (item.content as any[]).map(b => (typeof b?.content === "string" ? b.content : "")).filter(Boolean).join("\n")
                : item.content;
              const contentInput = {
                sourceType: item.type as "answer" | "article" | "pin",
                sourceId: String(item.id),
                title,
                sourceUrl,
                author: { name: item.author?.name, urlToken: item.author?.url_token, avatarUrl: item.author?.avatar_url, headline: item.author?.headline },
                question: item.question ? { id: String(item.question.id), title: item.question.title } : undefined,
                contentHtml: cleanHtml(rawContent),
                contentMd: "",
                excerpt: item.excerpt || "",
                voteupCount: item.voteup_count || item.reaction?.statistics?.like_count || item.reaction?.statistics?.upvote_count || 0,
                commentCount: item.comment_count || 0,
                favoriteCount: item.favorite_count || item.thanks_count || item.reaction?.statistics?.favorites || item.reaction?.statistics?.favorite_count || 0,
                visitCount: item.visit_count || item.reaction?.statistics?.visit_count || 0,
                isCollapsed: item.is_collapsed,
                isLabeled: item.is_labeled,
                labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
                createdTime: toIsoOrNull(item.created_time),
                updatedTime: toIsoOrNull(item.updated_time)
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
              } catch (e: any) {
                // 之前是空 catch：收藏条目入库失败连日志都没有，问题完全不可见
                stats.failed++;
                console.error(`❌ 收藏条目入库失败: ${title}`, e?.message || e);
              }
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
        // schema 单请求上限 1000 条：超大的收藏夹截断提交并跳过移除对账
        // （incremental=true），避免整个快照被 400 拒掉导致全部丢失
        const MAX_ITEMS = 1000;
        const overflow = items.length > MAX_ITEMS;
        if (overflow) {
          console.warn(`⚠️ 收藏夹 [${coll.title}] 共 ${items.length} 条超出单请求上限，本轮只提交前 ${MAX_ITEMS} 条并跳过移除对账`);
        }
        try {
          await sendCollectionSnapshot({
            collection: { id: coll.id, title: coll.title, ownerToken: ZHIHU_USERNAME || "", updatedTime: coll.updatedTime },
            // 抓取中断时必须跳过移除检测，防止把未抓到的条目误标移除
            incremental: cIncomplete || (cIsEnd && isFast) || overflow,
            items: overflow ? items.slice(0, MAX_ITEMS) : items
          });
        } catch (e: any) {
           stats.failed++;
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

  // 断点续传游标上报：moments 按 paging.next（before_id 游标）向更旧翻页。
  // 每翻完一页把"下一页游标"存到 Worker，run 无论何时中断（超时/额度/风控），
  // 下次都从断点继续，不用从头重翻几千条已入库的动态（实测重复成本会卡死进度）。
  // 游标到达末尾（is_end）或断点失效时上报 null 清除，下次恢复全量。
  const reportCursor = (url: string | null) =>
    post("/ingest/sync-state", { key: "upvotes_cursor", value: url })
      .catch(() => { /* 上报失败不阻塞抓取：最多下次多翻一段 */ });

  let nextUrl = `https://www.zhihu.com/api/v3/moments/${ZHIHU_USERNAME}/activities?limit=20`;
  // resuming=true 表示当前处于"从断点补历史"阶段（不做已存在早停）
  let resuming = false;
  let wantResume = false;
  let isEnd = false;
  let count = 0;
  let existingCount = 0;
  let consecutiveFailures = 0;

  while (!isEnd && nextUrl) {
    const res = await context.request.get(nextUrl);
    if (!res.ok()) {
      console.error(`❌ 获取动态失败: API 返回状态码 ${res.status()}`);
      if (res.status() === 401 || res.status() === 403) stats.authRejected++;
      else stats.failed++;
      // 断点游标失效（知乎改版/游标过期）时清掉，下次从头全量——宁可重翻不可卡死
      if (resuming) reportCursor(null);
      break;
    }
    const json = await res.json();
    if (!json.data || json.data.length === 0) {
      if (!json.paging?.is_end) {
        stats.riskEmpty++;
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
        createdTime: toIsoOrNull(target.created_time),
        updatedTime: toIsoOrNull(target.updated_time)
      };

      try {
        const pk = await sendContent(contentInput);
        consecutiveFailures = 0;
        if (pk) {
           const upvoteTime = toIsoOrNull(item.created_time);
           // created_time 缺失时为空串：/ingest/upvote 对空串返回 400，
           // 整条赞同上报会失败——内容已入库，跳过时间戳上报即可
           if (upvoteTime) {
             const upRes = await post(`/ingest/upvote`, { contentPk: pk.pk, upvoteTime });
             count++;

             if (!upRes.created) {
               existingCount++;
               if (existingCount >= 20 && isFast && !upvotesCursor) {
                 console.log("🛑 连续20个赞同记录无更新，停止本轮极速同步。");
                 isEnd = true;
                 break;
               }
               // 有断点：新增段撞到已入库的，标记切换到断点继续补历史
               // （快速/全量都走这条路径，实际跳转在页尾统一处理）
               if (existingCount >= 20 && upvotesCursor && !resuming) {
                 console.log("🔁 新增段完成（连续 20 条已存在），跳到上次断点继续补历史");
                 wantResume = true;
                 existingCount = 0;
                 break;
               }
             } else {
               existingCount = 0;
             }
           }
        }
      } catch (err: any) {
        stats.failed++;
        consecutiveFailures++;
        console.error(`❌ 保存赞同失败: ${title}`, err.message);
        if (consecutiveFailures >= 5) {
          console.error("🛑 连续 5 次入库失败（可能触发 D1 每日写入限额），暂停抓取并保留当前断点游标，下次从本页继续。");
          break;
        }
      }
    }

    if (consecutiveFailures >= 5) {
      break;
    }

    console.log(`💬 已拉取并保存 ${count} 条赞同记录...`);

    if (!isEnd) isEnd = json.paging?.is_end;

    // 页尾统一决定下一页：跳断点 > 正常游标
    if (wantResume) {
      nextUrl = upvotesCursor as string;
      wantResume = false;
      resuming = true;
    } else {
      nextUrl = json.paging?.next || "";
      // 新增段不上报（不论快速/全量）：上报会把"新增段的下一页"覆盖成
      // 历史断点，丢失补历史进度。resuming 阶段和翻到底时才上报/清游标
      if (resuming || !isFast) reportCursor(isEnd ? null : nextUrl);
    }

    if (json.data.length === 0) break;

    // 与其他三段对齐的节流：老账号动态可达数千页，背靠背请求极易触发 429
    // 并升级为账号级风控，连坐 answers/collections 两段
    await new Promise(r => setTimeout(r, 500));
  }

  await browser.close();
  console.log("🎉 赞同同步完成！");
}


// --- Apify Entry Point ---
// 失败必须让 run 状态可见。之前所有异常都被吞掉后正常 exit，
// cookie 失效后 run 依然 SUCCEEDED，Worker /auth 页据此误报"一切正常"。
try {
  if (runType === "all" || runType === "answers") {
    await runScraper();
  }
  if (runType === "all" || runType === "collections") {
    await runCollectionScraper();
  }
  if (runType === "all" || runType === "upvotes") {
    await runUpvotesScraper();
  }
} catch (e: any) {
  log.error(e?.message || String(e));
  await Actor.fail(`crawler_error: ${e?.message || String(e)}`);
  process.exit(1);
}

if ((stats.authRejected > 0 || stats.riskEmpty > 0) && stats.saved === 0) {
  await Actor.fail(`zhihu_auth_failed: 被知乎 401/403 拒绝 ${stats.authRejected} 次、疑似风控空页 ${stats.riskEmpty} 次（cookie 可能已失效或被风控），本轮零数据入库`);
  process.exit(1);
}
if (stats.saved === 0 && stats.failed > 0) {
  await Actor.fail(`ingest_failed: 回传 ${stats.failed} 次全部失败（检查 Worker 的 API_SECRET / WORKER_URL），本轮零数据入库`);
  process.exit(1);
}
if (stats.failed > 0 || stats.authRejected > 0 || stats.riskEmpty > 0) {
  log.warning(`本轮完成：交付 ${stats.saved} 条数据，${stats.failed} 次入库失败，被知乎拒绝 ${stats.authRejected} 次，疑似风控空页 ${stats.riskEmpty} 次`);
}

await Actor.exit();

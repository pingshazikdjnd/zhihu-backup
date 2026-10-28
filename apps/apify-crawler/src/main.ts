import { Actor, log } from "apify";
import { chromium } from "playwright";

interface InputSchema {
    runType: "all" | "answers" | "collections" | "upvotes" | "following" | "following-list";
    isFast: boolean;
    apiUrl: string;
    apiSecret?: string;
    zhihuUsername: string;
    cookieString: string;
    /** 赞同段断点游标（moments 的 paging.next）：从上次中断处继续补历史 */
    upvotesCursor?: string;
    /** 开启了「全量备份」的关注答主 url_token 列表 */
    fullModeUsers?: string[];
    /** 每位关注答主的历史扫描进度（断点 offset、是否已完成首次历史摸底、上次最新回答标记点） */
    followedProgress?: Record<string, { resumeOffset: number; historyDone: boolean; syncMode: "default" | "full"; lastCheckedAnswerId?: string }>;
    /** 全局同步与评论抓取策略设置 */
    syncConfig?: {
      commentsMyAnswers?: "full" | "hot" | "none";
      commentsCollections?: "full" | "hot" | "none";
      commentsUpvotes?: "full" | "hot" | "none";
      commentsFollowing?: "full" | "hot" | "none";
      followingSensitivity?: "strict" | "standard" | "relaxed";
    };
}

await Actor.init();
const input = await Actor.getInput<InputSchema>();
if (!input) throw new Error("Missing input");
const { runType, isFast, apiUrl, apiSecret, zhihuUsername, cookieString, upvotesCursor, fullModeUsers, followedProgress, syncConfig } = input;
const fullModeSet = new Set(Array.isArray(fullModeUsers) ? fullModeUsers : []);
const followedProgMap = followedProgress && typeof followedProgress === "object" ? followedProgress : {};
const cfg = {
  commentsMyAnswers: syncConfig?.commentsMyAnswers || "full",
  commentsCollections: syncConfig?.commentsCollections || "hot",
  commentsUpvotes: syncConfig?.commentsUpvotes || "hot",
  commentsFollowing: syncConfig?.commentsFollowing || "hot",
  followingSensitivity: syncConfig?.followingSensitivity || "standard"
};

// 失败上报：所有异常都被吞掉的爬虫在 Apify 上永远显示 SUCCEEDED，
// cookie 失效后零数据入库也毫无感知。这里集中统计，结束时据此决定 run 状态。
const MAX_DAILY_ESTIMATED_WRITES = 90000; // 90000 < D1 免费版硬顶 100000 行/天：留 10% 余量给配置写入与并发，避免撞墙后整轮 500
const stats = {
  saved: 0,
  failed: 0,
  authRejected: 0,
  riskEmpty: 0,
  consecutiveFailures: 0,
  circuitBroken: false,
  estimatedWrites: 0
};

async function post(path: string, body: unknown): Promise<any> {
  // apiUrl 尾斜杠归一，避免拼出 //ingest/content 的 404
  const base = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiSecret) headers["authorization"] = `Bearer ${apiSecret}`;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (e: any) {
    stats.failed++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures >= 5) stats.circuitBroken = true;
    throw e;
  }
  if (!res.ok) {
    stats.failed++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures >= 5) stats.circuitBroken = true;
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  // 成功计数放在 JSON 解析之后：200+非 JSON 体时避免 saved/failed 双计
  let json: any;
  try {
    json = await res.json();
  } catch (e: any) {
    stats.failed++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures >= 5) stats.circuitBroken = true;
    throw e;
  }
  stats.saved++;
  stats.consecutiveFailures = 0;

  let cost = 1;
  if (path === "/ingest/content") cost = 3;
  else if (path === "/ingest/comments") cost = Math.max(1, ((body as any)?.comments?.length || 1) * 2);
  else if (path === "/ingest/upvote") cost = 2;
  else if (path === "/ingest/collection-snapshot") cost = Math.max(1, (body as any)?.items?.length || 1);
  else if (path === "/ingest/followed-users") cost = Math.max(1, (body as any)?.users?.length || 1);

  stats.estimatedWrites += cost;
  if (stats.estimatedWrites >= MAX_DAILY_ESTIMATED_WRITES) {
    if (!stats.circuitBroken) {
      stats.circuitBroken = true;
      console.warn(`\n🛑 [D1每日限额保护] 今日预估写入已达 ${stats.estimatedWrites} 行（已充分吃满 CF 官方 100k 额度并适度利用缓冲）。主动安全挂起，已保存断点，等待明日 08:05 额度刷新后自动续跑！`);
    }
  }

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
  let pagesScanned = 0;
  let submitted = 0;
  let createdCount = 0;
  let noChangeCount = 0;
  
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

    pagesScanned++;
    for (const item of json.data) {
      if (item.type !== "answer") continue;

      // 列表接口 include 已显式请求 voteup_count/visit_count/favorite_count/comment_count，
      // 之前每条回答再单独请求一次 /answers/{id} 拿同样字段，纯属 562 次多余请求
      const finalVoteup = item.voteup_count || item.reaction?.statistics?.like_count || item.reaction?.statistics?.upvote_count || 0;
      const finalFavorite = item.favorite_count || item.thanks_count || item.reaction?.statistics?.favorites || item.reaction?.statistics?.favorite_count || 0;
      const finalVisit = item.visit_count || item.reaction?.statistics?.visit_count || 0;

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
        submitted++;
        if (dbRes.created) createdCount++;
        else if (!dbRes.changed) noChangeCount++;
        console.log(`✅ 保存回答: ${contentInput.title}${dbRes.created ? " [新增]" : dbRes.changed ? " [有正文/元数据变更]" : " [无变化·仅计数同步]"}`);
        
        const needComments =
          cfg.commentsMyAnswers !== "none" &&
          contentInput.commentCount > 0 &&
          contentInput.commentCount > (dbRes.prevCommentCount || 0);
        if (needComments) {
          console.log(`💬 发现待备份/更新评论 (${dbRes.prevCommentCount || 0} -> ${contentInput.commentCount})，加入抓取队列`);
          pendingCommentsQueue.push({ answerId: String(item.id), url: contentInput.sourceUrl });
          existingCount = 0;
        } else if (!dbRes.created && !dbRes.changed) {
          existingCount++;
          if (existingCount >= 20 && isFast) {
            console.log("🛑 连续20个条目及评论均无更新，停止本轮极速同步。");
            isEnd = true;
            break;
          }
        } else {
          existingCount = 0;
        }
      } catch (err: any) {
        console.error(`❌ 保存回答失败: ${err.message}`);
        if (stats.circuitBroken) {
          console.error("🛑 连续 5 次入库失败（可能触发 D1 每日写入限额），暂停回答同步。");
          isEnd = true;
          break;
        }
      }
    }

    if (stats.circuitBroken) break;
    if (!isEnd) isEnd = json.paging?.is_end;
    offset += 20;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (pendingCommentsQueue.length > 0 && !stats.circuitBroken) {
    console.log(`💬 正在抓取 ${pendingCommentsQueue.length} 篇回答的评论...`);
    for (const task of pendingCommentsQueue) {
      if (stats.circuitBroken) break;
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
        if (cfg.commentsMyAnswers === "hot" && cOffset >= 20) {
          cIncomplete = true;
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
           console.error(`❌ 保存评论失败: ${err.message}`);
           if (stats.circuitBroken) break;
        }
      } else if (cIncomplete) {
        console.warn(`⚠️ 回答 ${task.answerId} 评论抓取中断且无数据，跳过本轮提交`);
      }
    }
  }

  console.log("🎉 回答和评论同步完成！");
  console.log(
    `📊 本轮我的回答：扫描 ${pagesScanned} 页 / 提交 ${submitted} 条 / 新增 ${createdCount} 条 / 无变化 ${noChangeCount} 条` +
    (isFast && existingCount >= 20 ? "（命中连续无更新早停）" : "")
  );
  await browser.close();
}

/**
 * 按设置策略（none: 不抓 / hot: 前1页20条高赞热评+内联子评论 / full: 全量分页抓取）
 * 为收藏夹/赞同/关注答主的回答或文章抓取评论。
 */
async function syncHotCommentsForContent(
  context: any,
  sourceType: "answer" | "article" | "pin",
  sourceId: string,
  mode: "full" | "hot" | "none" = "hot"
) {
  if (mode === "none") return;
  if (sourceType !== "answer" && sourceType !== "article") return;
  if (stats.circuitBroken) return;

  const endpointType = sourceType === "article" ? "articles" : "answers";
  try {
    let cOffset = 0;
    let cIsEnd = false;
    let cIncomplete = false;
    const allComments: any[] = [];
    const maxPages = mode === "full" ? 200 : 1;
    let pagesFetched = 0;

    while (!cIsEnd && pagesFetched < maxPages && !stats.circuitBroken) {
      const cRes = await context.request.get(
        `https://www.zhihu.com/api/v4/${endpointType}/${sourceId}/root_comments?limit=20&offset=${cOffset}`
      );
      if (!cRes.ok()) {
        cIncomplete = true;
        break;
      }
      const cJson = await cRes.json();
      if (!cJson.data || cJson.data.length === 0) {
        if (!cJson.paging?.is_end) cIncomplete = true;
        break;
      }

      for (const c of cJson.data) {
        let imgUrl = "";
        let textContent = c.content || "";
        const imgMatch = textContent.match(/<a[^>]+href="([^"]+)"[^>]*>.*?查看图片.*?<\/a>/i);
        if (imgMatch) {
          imgUrl = imgMatch[1];
          textContent = textContent.replace(imgMatch[0], "").trim();
        }
        allComments.push({
          id: String(c.id),
          parentId: c.reply_to_comment_id ? String(c.reply_to_comment_id) : null,
          author: c.author?.member?.name || "匿名",
          authorAvatar: c.author?.member?.avatar_url || "",
          beReplied: null,
          content: cleanHtml(textContent),
          img: imgUrl,
          time: toIsoOrNull(c.created_time),
          location: c.address_text || "",
          likes: c.vote_count || c.reaction?.statistics?.like_count || 0,
          isAuthor: c.is_author === true || c.is_author === 1 || c.author?.role === "author",
          isTop: c.top === true || c.top === 1,
          isFeatured: c.featured === true || c.featured === 1
        });

        if (Array.isArray(c.child_comments)) {
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

      cIsEnd = Boolean(cJson.paging?.is_end);
      cOffset += 20;
      pagesFetched++;
      if (!cIsEnd && pagesFetched < maxPages) {
        await new Promise(r => setTimeout(r, 350));
      }
    }

    if (allComments.length > 0) {
      const uniqueMap = new Map(allComments.map(c => [c.id, c] as const));
      const finalComments = [...uniqueMap.values()];
      const CHUNK = 500;
      for (let i = 0; i < finalComments.length; i += CHUNK) {
        const isLast = i + CHUNK >= finalComments.length;
        await sendComments({
          contentPk: `${sourceType}:${sourceId}`,
          comments: finalComments.slice(i, i + CHUNK),
          partial: mode === "hot" ? true : (isLast ? (cIncomplete || !cIsEnd) : true),
          ...(mode === "full" && isLast && cIsEnd && !cIncomplete ? { allIds: finalComments.map(c => c.id) } : {})
        });
      }
    }
  } catch (e: any) {
    console.warn(`⚠️ 抓取评论跳过 (${sourceType}:${sourceId}): ${e?.message || e}`);
  }
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
      if (stats.circuitBroken) break;
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
            let contentSaved = true;
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
                const needHotComments =
                  cfg.commentsCollections !== "none" &&
                  contentInput.commentCount > 0 &&
                  (dbRes.prevCommentCount || 0) === 0;
                if (needHotComments && !stats.circuitBroken) {
                  await syncHotCommentsForContent(context, item.type as "answer" | "article" | "pin", String(item.id), cfg.commentsCollections);
                }
                if (!dbRes.created && !dbRes.changed && !needHotComments) {
                  existingCount++;
                  if (existingCount >= 20 && isFast) {
                    console.log("🛑 连续20个收藏条目及评论均无更新，停止本收藏夹的极速同步。");
                    cIsEnd = true;
                    break;
                  }
                } else {
                  existingCount = 0;
                }
              } catch (e: any) {
                contentSaved = false;
                cIncomplete = true;
                console.error(`❌ 收藏条目入库失败: ${title}`, e?.message || e);
                if (stats.circuitBroken) {
                  console.error("🛑 连续 5 次入库失败（可能触发 D1 每日写入限额），暂停收藏夹同步。");
                  cIsEnd = true;
                  break;
                }
              }
            }

            if (contentSaved) {
              items.push({
                 sourceType,
                 sourceId: String(item.id),
                 title,
                 authorName: item.author?.name || "匿名",
                 sourceUrl
              });
            }
         }
         
         if (stats.circuitBroken) break;
         if (!cIsEnd) cIsEnd = cJson.paging?.is_end;
         cOffset += 20;
         await new Promise(r => setTimeout(r, 500));
      }
      
      if (items.length > 0 && !stats.circuitBroken) {
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
           console.error(`❌ 收藏夹保存失败: ${e.message}`);
        }
      } else if (!stats.circuitBroken) {
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

  // 判断当前翻页游标是否已经自然追上或越过上次保存的断点（处理上次断点前已存在赞同不足 20 条的边界）
  function hasReachedCursor(candidateUrl: string, savedCursor?: string): boolean {
    if (!savedCursor || !candidateUrl) return false;
    if (candidateUrl === savedCursor) return true;
    try {
      const u1 = new URL(candidateUrl);
      const u2 = new URL(savedCursor);
      const p1 = Number(u1.searchParams.get("page_num"));
      const p2 = Number(u2.searchParams.get("page_num"));
      if (Number.isFinite(p1) && Number.isFinite(p2) && p1 > 0 && p2 > 0 && p1 >= p2) return true;
      const o1 = Number(u1.searchParams.get("offset"));
      const o2 = Number(u2.searchParams.get("offset"));
      if (Number.isFinite(o1) && Number.isFinite(o2) && o1 > 0 && o2 > 0 && o1 <= o2) return true;
    } catch { /* ignore */ }
    return false;
  }

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
      const status = res.status();
      console.error(`❌ 获取动态失败: API 返回状态码 ${status}`);
      if (status === 401 || status === 403) stats.authRejected++;
      else stats.failed++;
      // 仅当游标 URL 本身失效（400/404/410）时才清掉断点；
      // 401/403 风控或 Cookie 过期、429 限流、5xx 服务端抖动必须保留断点！
      if (resuming && (status === 400 || status === 404 || status === 410)) {
        await reportCursor(null);
      }
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

    let pageFailures = 0;

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
        if (pk) {
           if (
             cfg.commentsUpvotes !== "none" &&
             contentInput.commentCount > 0 &&
             (pk.prevCommentCount || 0) === 0 &&
             !stats.circuitBroken
           ) {
             await syncHotCommentsForContent(context, sourceType, sourceId, cfg.commentsUpvotes);
           }
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
        // content 与 upvote 两步都成功才清零连续失败计数
        consecutiveFailures = 0;
      } catch (err: any) {
        pageFailures++;
        consecutiveFailures++;
        console.error(`❌ 保存赞同失败: ${title}`, err.message);
        if (consecutiveFailures >= 5 || stats.circuitBroken) {
          console.error("🛑 连续 5 次入库失败（可能触发 D1 每日写入限额），暂停抓取并保留当前断点游标，下次从本页继续。");
          break;
        }
      }
    }

    // 只要本页有任何入库失败（pageFailures > 0），严禁推进内存 nextUrl 或覆盖云端游标，
    // 否则若下一页恰好无赞同（0 次调用 post）或恢复成功，就会把本页失败的条目永久跳过！
    if (pageFailures > 0 || consecutiveFailures >= 5 || stats.circuitBroken) {
      if (pageFailures > 0 && consecutiveFailures < 5 && !stats.circuitBroken) {
        console.warn(`⚠️ 本页有 ${pageFailures} 条赞同入库失败，暂停翻页并保留当前断点游标，下次从本页重跑以防漏存。`);
      }
      break;
    }

    console.log(`💬 已拉取并保存 ${count} 条赞同记录...`);

    // 页尾统一决定下一页：跳断点 > 正常游标
    if (wantResume) {
      nextUrl = upvotesCursor as string;
      wantResume = false;
      resuming = true;
    } else {
      if (!isEnd) isEnd = Boolean(json.paging?.is_end);
      nextUrl = json.paging?.next || "";
      // 若新增段自然翻到了历史断点所在页（或已越过），自动进入 resuming 状态
      if (upvotesCursor && !resuming && hasReachedCursor(nextUrl, upvotesCursor)) {
        resuming = true;
      }
      // 当存在历史断点且尚未进入 resuming 阶段时（正在扫最新动态），
      // 严禁上报游标（不论快速/全量），否则第 1 页未凑齐 20 条已存在记录时就会把深水区断点覆盖回第 2 页！
      const inHeadBeforeResume = Boolean(upvotesCursor) && !resuming && !isEnd;
      if (!inHeadBeforeResume && (resuming || !isFast)) {
        await reportCursor(isEnd ? null : nextUrl);
      }
    }

    if (json.data.length === 0) break;

    // 与其他三段对齐的节流：老账号动态可达数千页，背靠背请求极易触发 429
    // 并升级为账号级风控，连坐 answers/collections 两段
    await new Promise(r => setTimeout(r, 500));
  }

  await browser.close();
  if (stats.circuitBroken) {
    console.log("⏸️ 赞同同步因写入限额断路器暂停，断点已保留。");
  } else {
    console.log("🎉 赞同同步完成！");
  }
}

export async function runFollowingScraper(onlyList = false) {
  const browser = await setupBrowser();
  console.log("🚀 开始同步你关注的人...");

  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  const followedUsers: Array<{
    urlToken: string;
    userId: string;
    name: string;
    avatarUrl: string;
    headline: string;
    answerCount: number;
    articlesCount: number;
    followerCount: number;
  }> = [];

  let offset = 0;
  let isEnd = false;
  let fIncomplete = false;

  while (!isEnd) {
    const res = await context.request.get(
      `https://www.zhihu.com/api/v4/members/${ZHIHU_USERNAME}/followees?include=data%5B*%5D.answer_count,articles_count,follower_count,headline,avatar_url&limit=20&offset=${offset}`
    );
    if (!res.ok()) {
      console.error(`❌ 获取关注列表失败: HTTP ${res.status()}`);
      if (res.status() === 401 || res.status() === 403) stats.authRejected++;
      else stats.failed++;
      fIncomplete = true;
      break;
    }
    const json = await res.json();
    if (!json.data || json.data.length === 0) {
      if (!json.paging?.is_end) {
        stats.riskEmpty++;
        fIncomplete = true;
      }
      break;
    }

    for (const u of json.data) {
      if (!u.url_token || !u.name) continue;
      followedUsers.push({
        urlToken: String(u.url_token),
        userId: String(u.id || ""),
        name: String(u.name),
        avatarUrl: String(u.avatar_url || ""),
        headline: String(u.headline || ""),
        answerCount: Number(u.answer_count) || 0,
        articlesCount: Number(u.articles_count) || 0,
        followerCount: Number(u.follower_count) || 0
      });
    }

    isEnd = Boolean(json.paging?.is_end);
    offset += 20;
    await new Promise(r => setTimeout(r, 400));
  }

  if (followedUsers.length > 0) {
    try {
      await post("/ingest/followed-users", {
        users: followedUsers,
        incremental: fIncomplete
      });
      console.log(`✅ 已同步 ${followedUsers.length} 位关注答主名录`);
    } catch (e: any) {
      console.error(`❌ 上报关注答主名录失败: ${e?.message || e}`);
    }
  }

  if (onlyList || stats.circuitBroken) {
    await browser.close();
    return;
  }

  // 同步关注答主的回答：
  // - 开启了「全量备份（full）」的答主优先排在前面，抓取全量（快速模式下连续 15 条未变则早停）
  // - 默认精选模式的答主：每人最多抓取前 50 篇（快速模式下只看最新第 1 页且连续 5 条未变即停）
  const sortedUsers = [...followedUsers].sort((a, b) => {
    const aFull = fullModeSet.has(a.urlToken) ? 1 : 0;
    const bFull = fullModeSet.has(b.urlToken) ? 1 : 0;
    return bFull - aFull;
  });

  const includeStr = encodeURIComponent(
    "data[*].is_normal,comment_count,content,voteup_count,created_time,updated_time,question,excerpt,is_collapsed,is_labeled,label_info,visit_count,favorite_count"
  );
  const articleIncludeStr = encodeURIComponent(
    "data[*].content,voteup_count,comment_count,created,updated,title,excerpt"
  );

  // 抓取侧实时「和谐风险 + 内容含金量」评估器：
  // 扫描关注答主的回答时，自动甄别「写得好但容易被和谐」的高危/精品回答入库，跳过日常普通水贴，兼顾容量与抢救质量！
  const HIGH_RISK_KWS = [
    "审查", "封禁", "删帖", "河蟹", "和谐", "敏感", "禁评", "夹总", "小管家",
    "文革", "苏联", "解体", "政治", "政权", "意识形态", "官僚", "特权", "权贵", "既得利益",
    "阶级", "阶层固化", "剥削", "牛马", "人矿", "烂尾", "维权", "赋红码", "公信力",
    "人口崩塌", "生育率", "断交", "制裁", "房价崩盘", "失业率", "洗脑", "润学", "润出", "亡国",
    "贪腐", "腐败", "垄断", "内幕", "真相", "反思", "历史虚无", "拜金", "男女对立", "彩礼"
  ];
  const MED_RISK_KWS = [
    "华为", "公知", "民族", "爱国", "资本家", "996", "劳动法", "工会", "裁员",
    "房地产", "土地财政", "城投", "地方债", "集采", "医保", "养老金", "延迟退休",
    "教育公平", "学区房", "考公", "编制", "国企", "央企", "体制内", "贫富差距",
    "俄乌", "中东", "以色列", "巴勒斯坦", "台海", "关税", "贸易战", "芯片封锁"
  ];

  function evaluateForAutoBackup(item: any, rawHtml: string): { shouldBackup: boolean; reason: string; riskScore: number; valueScore: number } {
    let risk = 0;
    let value = 0;
    const reasons: string[] = [];

    const voteup = Number(item?.voteup_count) || 0;
    const comments = Number(item?.comment_count) || 0;
    const favs = Number(item?.favorite_count) || 0;
    const isCollapsed = Boolean(item?.is_collapsed);
    const isLabeled = Boolean(item?.is_labeled) || Boolean(item?.label_info);
    const text = `${item?.question?.title || ""} ${item?.title || ""} ${item?.excerpt || ""} ${rawHtml.slice(0, 1500)}`.toLowerCase();
    const textLen = rawHtml.replace(/<[^>]+>/g, "").trim().length;

    if (isCollapsed) { risk += 45; reasons.push("原站已折叠"); }
    if (isLabeled) { risk += 30; reasons.push("风险黄标"); }
    if (voteup >= 1000 && comments === 0) { risk += 35; reasons.push("千赞零评疑似禁评"); }
    else if (voteup >= 200 && comments === 0) { risk += 25; reasons.push("高赞零评疑似禁评"); }
    else if (voteup >= 1500 && comments > 0 && voteup / comments >= 80) { risk += 18; reasons.push("评论严控"); }

    let highHits = 0;
    for (const kw of HIGH_RISK_KWS) {
      if (text.includes(kw)) { highHits++; if (highHits >= 3) break; }
    }
    let medHits = 0;
    for (const kw of MED_RISK_KWS) {
      if (text.includes(kw)) { medHits++; if (medHits >= 3) break; }
    }
    if (highHits > 0) { risk += 22 + (highHits - 1) * 10; reasons.push("高敏议题"); }
    else if (medHits > 0) { risk += 14 + (medHits - 1) * 7; reasons.push("争议议题"); }

    // “写得好”含金量：赞同数 + 收藏赞同比 + 深度长文
    if (voteup >= 5000) value += 40;
    else if (voteup >= 1000) value += 30;
    else if (voteup >= 300) value += 22;
    else if (voteup >= 80) value += 14;

    const favRatio = voteup >= 30 ? favs / voteup : 0;
    if (favRatio >= 0.45) { value += 28; risk += 10; reasons.push("极高收藏比神贴"); }
    else if (favRatio >= 0.25 || favs >= 500) { value += 18; reasons.push("高收藏干货"); }

    if (textLen >= 1200) value += 15;
    else if (textLen >= 500) value += 8;

    if ((highHits > 0 || medHits > 0) && (voteup >= 100 || textLen >= 400)) {
      risk += 10;
    }

    // 判定准则（支持 sensitivity: strict | standard | relaxed）：
    const riskThreshold = cfg.followingSensitivity === "strict" ? 40 : cfg.followingSensitivity === "relaxed" ? 18 : 25;
    const valueThreshold = cfg.followingSensitivity === "strict" ? 50 : cfg.followingSensitivity === "relaxed" ? 24 : 38;
    const isHighRiskWorthSaving = risk >= riskThreshold && (value >= 8 || textLen >= 150 || isCollapsed || isLabeled);
    const isHighQuality = value >= valueThreshold;

    return {
      shouldBackup: isHighRiskWorthSaving || isHighQuality,
      reason: reasons.join("+") || (isHighQuality ? "高赞深度精品" : "常规"),
      riskScore: Math.min(100, risk),
      valueScore: Math.min(100, value)
    };
  }

  const reportUserProgress = (urlToken: string, resumeOffset: number, historyDone: boolean, lastCheckedAnswerId?: string) =>
    post("/ingest/followed-user-progress", { urlToken, resumeOffset, historyDone, lastCheckedAnswerId }).catch(() => {});

  for (const u of sortedUsers) {
    if (stats.circuitBroken) break;
    if (u.answerCount <= 0 && u.articlesCount <= 0) continue;

    const isUserFull = fullModeSet.has(u.urlToken);
    const prog = followedProgMap[u.urlToken] || { resumeOffset: 0, historyDone: false, lastCheckedAnswerId: "" };
    const isHistoryDone = Boolean(prog.historyDone);
    const lastMarkAnswerId = String(prog.lastCheckedAnswerId || "");
    let newestSeenAnswerId = "";

    // 核心分流逻辑：
    // - 若该答主已完成首次历史存量扫描（historyDone === true）且当前为日常快速同步（isFast === true）：
    //   只从最新第 1 页（offset=0, sort_by=created）往后看，遇到连续已存在记录（碰到上次的标记点）立即停止！
    // - 若该答主尚未完成首次历史存量扫描（historyDone === false）或手动跑全量（!isFast）：
    //   - 默认模式：扫描最新 60 篇 + 最高赞 60 篇，自动抢救所有高危/精品回答，扫完即标 historyDone = true；
    //   - 全量模式：先看第 1 页最新增量，然后直接从上次保存的断点 prog.resumeOffset 继续往后抓全量，每页更新断点，抓到底标 historyDone = true！
    const onlyIncrementalNow = isFast && isHistoryDone;

    console.log(
      `👤 同步关注答主 [${u.name}] (${
        onlyIncrementalNow
          ? "日常增量 · 扫描最新动态至上次标记点"
          : isUserFull
          ? `全量断点续传 · 从第 ${prog.resumeOffset || 0} 篇继续 (共 ${u.answerCount} 回答)`
          : "首次历史摸底 · 扫描最新+最高赞并自动抢救高危/精品回答"
      })...`
    );

    let completedAllPlans = true;

    if (u.answerCount > 0 && !stats.circuitBroken) {
      const plans: Array<{ sortBy: "created" | "voteups"; startOffset: number; maxScan: number; earlyStop: number; trackResume: boolean }> =
        onlyIncrementalNow
          ? [{ sortBy: "created", startOffset: 0, maxScan: 40, earlyStop: 5, trackResume: false }]
          : isUserFull
          ? [
              ...(prog.resumeOffset > 0
                ? [{ sortBy: "created" as const, startOffset: 0, maxScan: 20, earlyStop: 5, trackResume: false }]
                : []),
              { sortBy: "created" as const, startOffset: prog.resumeOffset || 0, maxScan: 100000, earlyStop: 999999, trackResume: true }
            ]
          : [
              { sortBy: "created", startOffset: 0, maxScan: 60, earlyStop: 999999, trackResume: false },
              { sortBy: "voteups", startOffset: 0, maxScan: 60, earlyStop: 999999, trackResume: false }
            ];

      let savedForUser = 0;
      for (const plan of plans) {
        if (stats.circuitBroken) { completedAllPlans = false; break; }
        let aOffset = plan.startOffset;
        let aIsEnd = false;
        let unchanged = 0;

        while (!aIsEnd && aOffset < plan.maxScan && !stats.circuitBroken) {
          const batchLimit = Math.min(20, plan.maxScan - aOffset);
          const aRes = await context.request.get(
            `https://www.zhihu.com/api/v4/members/${u.urlToken}/answers?include=${includeStr}&limit=${batchLimit}&offset=${aOffset}&sort_by=${plan.sortBy}`
          );
          if (!aRes.ok()) { completedAllPlans = false; break; }
          const aJson = await aRes.json();
          if (!aJson.data || aJson.data.length === 0) break;

          let pageFailed = false;
          for (const item of aJson.data) {
            if (!item?.id) continue;
            const itemIdStr = String(item.id);
            if (plan.sortBy === "created" && aOffset === 0 && !newestSeenAnswerId) {
              newestSeenAnswerId = itemIdStr;
            }
            // 阶段二日常增量：一旦撞到上次扫描记录的最新回答标记点 lastMarkAnswerId，立即停下（哪怕中间跳过了水贴也能精确停住，0 次多余数据库写入！）
            if (onlyIncrementalNow && lastMarkAnswerId && itemIdStr === lastMarkAnswerId) {
              aIsEnd = true;
              break;
            }

            const cleanedHtml = cleanHtml(item.content);

            if (!isUserFull) {
              const evalRes = evaluateForAutoBackup(item, cleanedHtml);
              if (!evalRes.shouldBackup) {
                continue; // 普通低风险水贴直接跳过，不占 D1 / R2 容量
              }
              console.log(`  🛡️ [自动抢救 ${u.name}] 风险${evalRes.riskScore}分/质量${evalRes.valueScore}分 (${evalRes.reason}): ${item.question?.title || item.id}`);
            }

            const contentInput = {
              sourceType: "answer" as const,
              sourceId: String(item.id),
              title: item.question?.title || "未知问题",
              sourceUrl: `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`,
              author: {
                name: item.author?.name || u.name,
                urlToken: item.author?.url_token || u.urlToken,
                avatarUrl: item.author?.avatar_url || u.avatarUrl,
                headline: item.author?.headline || u.headline
              },
              question: item.question ? { id: String(item.question.id), title: item.question.title } : undefined,
              contentHtml: cleanedHtml,
              contentMd: "",
              excerpt: item.excerpt || "",
              voteupCount: item.voteup_count || 0,
              commentCount: item.comment_count || 0,
              favoriteCount: item.favorite_count || 0,
              visitCount: item.visit_count || 0,
              isCollapsed: item.is_collapsed,
              isLabeled: item.is_labeled,
              labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
              createdTime: toIsoOrNull(item.created_time),
              updatedTime: toIsoOrNull(item.updated_time)
            };

            try {
              const dbRes = await sendContent(contentInput);
              if (
                cfg.commentsFollowing !== "none" &&
                contentInput.commentCount > 0 &&
                (dbRes.prevCommentCount || 0) === 0 &&
                !stats.circuitBroken
              ) {
                await syncHotCommentsForContent(context, "answer", String(item.id), cfg.commentsFollowing);
              }
              savedForUser++;
              if (!dbRes.created && !dbRes.changed) {
                unchanged++;
                if (unchanged >= plan.earlyStop) {
                  aIsEnd = true;
                  break;
                }
              } else {
                unchanged = 0;
              }
            } catch (err: any) {
              pageFailed = true;
              completedAllPlans = false;
              console.error(`❌ 保存关注答主回答失败: ${err.message}`);
              if (stats.circuitBroken) break;
            }
          }

          if (pageFailed || stats.circuitBroken) {
            completedAllPlans = false;
            break;
          }

          if (!aIsEnd) aIsEnd = Boolean(aJson.paging?.is_end);
          aOffset += batchLimit;
          if (plan.trackResume && !aIsEnd) {
            await reportUserProgress(u.urlToken, aOffset, false);
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }
      if (!isUserFull && savedForUser > 0) {
        console.log(`  ✅ [${u.name}] 智能风险抢救共入库 ${savedForUser} 篇高危/精品回答`);
      }
    }

    // 2. 抓取专栏文章（全量模式下抓全部文章；智能模式下扫描最新 40 篇文章并只自动备份高危/高质文章）
    if (u.articlesCount > 0 && !stats.circuitBroken) {
      let artOffset = 0;
      let artIsEnd = false;
      let unchanged = 0;
      const maxArticles = isUserFull ? 100000 : (isFast ? 20 : 40);
      const artEarlyStop = isFast ? 5 : 999999;

      while (!artIsEnd && artOffset < maxArticles && !stats.circuitBroken) {
        const batchLimit = Math.min(20, maxArticles - artOffset);
        const artRes = await context.request.get(
          `https://www.zhihu.com/api/v4/members/${u.urlToken}/articles?include=${articleIncludeStr}&limit=${batchLimit}&offset=${artOffset}`
        );
        if (!artRes.ok()) break;
        const artJson = await artRes.json();
        if (!artJson.data || artJson.data.length === 0) break;

        for (const item of artJson.data) {
          if (!item?.id) continue;
          const cleanedHtml = cleanHtml(item.content);
          if (!isUserFull) {
            const evalRes = evaluateForAutoBackup(item, cleanedHtml);
            if (!evalRes.shouldBackup) continue;
            console.log(`  🛡️ [自动抢救文章 ${u.name}] 风险${evalRes.riskScore}分/质量${evalRes.valueScore}分 (${evalRes.reason}): ${item.title}`);
          }
          const contentInput = {
            sourceType: "article" as const,
            sourceId: String(item.id),
            title: item.title || "未知文章",
            sourceUrl: `https://zhuanlan.zhihu.com/p/${item.id}`,
            author: {
              name: item.author?.name || u.name,
              urlToken: item.author?.url_token || u.urlToken,
              avatarUrl: item.author?.avatar_url || u.avatarUrl,
              headline: item.author?.headline || u.headline
            },
            contentHtml: cleanedHtml,
            contentMd: "",
            excerpt: item.excerpt || "",
            voteupCount: item.voteup_count || 0,
            commentCount: item.comment_count || 0,
            favoriteCount: item.favorite_count || 0,
            visitCount: item.visit_count || 0,
            createdTime: toIsoOrNull(item.created || item.created_time),
            updatedTime: toIsoOrNull(item.updated || item.updated_time)
          };

          try {
            const dbRes = await sendContent(contentInput);
            if (!dbRes.created && !dbRes.changed) {
              unchanged++;
              if (unchanged >= artEarlyStop) {
                artIsEnd = true;
                break;
              }
            } else {
              unchanged = 0;
            }
          } catch (err: any) {
            completedAllPlans = false;
            console.error(`❌ 保存关注答主文章失败: ${err.message}`);
            if (stats.circuitBroken) break;
          }
        }

        if (!artIsEnd) artIsEnd = Boolean(artJson.paging?.is_end);
        artOffset += batchLimit;
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (completedAllPlans && !stats.circuitBroken && (!isHistoryDone || (newestSeenAnswerId && newestSeenAnswerId !== lastMarkAnswerId))) {
      await reportUserProgress(u.urlToken, 0, true, newestSeenAnswerId || lastMarkAnswerId || undefined);
    }
  }

  await browser.close();
  console.log("🎉 关注答主同步完成！");
}


// --- Apify Entry Point ---
// 失败必须让 run 状态可见。之前所有异常都被吞掉后正常 exit，
// cookie 失效后 run 依然 SUCCEEDED，Worker /auth 页据此误报"一切正常"。
try {
  if (runType === "following-list") {
    await runFollowingScraper(true);
  } else if (runType === "following") {
    await runFollowingScraper(false);
  } else {
    if (runType === "all") {
      // 先同步关注人名录（写 R2 + D1，耗时仅 3 秒）
      await runFollowingScraper(true);
    }
    if ((runType === "all" || runType === "answers") && !stats.circuitBroken) {
      await runScraper();
    }
    if ((runType === "all" || runType === "collections") && !stats.circuitBroken) {
      await runCollectionScraper();
    }
    if ((runType === "all" || runType === "upvotes") && !stats.circuitBroken) {
      await runUpvotesScraper();
    }
    if (runType === "all" && !stats.circuitBroken) {
      // 若自身回答/收藏/赞同跑完后当日 D1 配额仍有富余，继续同步关注答主的回答
      await runFollowingScraper(false);
    }
  }
} catch (e: any) {
  log.error(e?.message || String(e));
  await Actor.fail(`crawler_error: ${e?.message || String(e)}`);
  process.exit(1);
}

if (stats.circuitBroken) {
  log.warning(`本轮触发连续失败断路器暂停（已保存 ${stats.saved} 条数据，失败 ${stats.failed} 次），断点已保留供下次继续`);
  await Actor.exit({ exitCode: 2 });
  process.exit(2);
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

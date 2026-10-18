import { Hono } from "hono";
import { getContentDetail, listContents } from "../services/contents.js";
import { listComments } from "../services/comments.js";
import { db } from "../db.js";

export const contentRoutes = new Hono();

contentRoutes.get("/", c => {
  const type = c.req.query("type");
  const q = c.req.query("q");
  const author = c.req.query("author");
  const page = parseInt(c.req.query("page") || "1", 10);
  const { rows, total } = listContents({ type, q, author, page });
  return c.json({ data: rows, total });
});

contentRoutes.get("/:pk", c => {
  const pk = c.req.param("pk");
  return c.json(getContentDetail(pk));
});

contentRoutes.get("/:pk/comments", c => {
  const pk = c.req.param("pk");
  return c.json({ data: listComments(pk) });
});

contentRoutes.post("/:pk/sync-live", async c => {
  const pk = c.req.param("pk");
  const [type, id] = pk.split(":");
  if (!id) return c.json({ error: "invalid pk" }, 400);

  const cookie = process.env.ZHIHU_COOKIE_STRING || process.env.ZHIHU_COOKIE_Z_C0 || "";
  const zhihuHeaders = {
    cookie,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };
  let url = "";
  if (type === "answer") {
    url = `https://www.zhihu.com/api/v4/answers/${id}?include=voteup_count,comment_count,visit_count,favorite_count`;
  } else if (type === "article") {
    url = `https://zhuanlan.zhihu.com/api/articles/${id}`;
  } else {
    return c.json({ error: "unsupported type" }, 400);
  }

  try {
    const res = await fetch(url, { headers: zhihuHeaders });
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) {
         db.prepare(`UPDATE contents SET is_deleted = 1 WHERE pk = ?`).run(pk);
         return c.json({ data: { is_deleted: 1 } });
      }
      // 其它错误码（风控/限流）不能当作正常数据解析
      return c.json({ error: `upstream ${res.status}` }, 502);
    }
    
    const data = await res.json();
    if (data.error && data.error.message) {
      if (data.error.code === 404 || data.error.message.includes("已删除") || data.error.message.includes("not found")) {
         db.prepare(`UPDATE contents SET is_deleted = 1 WHERE pk = ?`).run(pk);
         return c.json({ data: { is_deleted: 1 } });
      }
    }

    let voteup = data.voteup_count || 0;
    let comment = data.comment_count || 0;
    let visit = data.visit_count || 0;
    let fav = data.favorite_count || data.thanks_count || data.reaction?.statistics?.favorites || data.reaction?.statistics?.favorite_count || 0;

    if (type === "answer" && fav === 0) {
      try {
        const favlistsRes = await fetch(`https://www.zhihu.com/api/v4/answers/${id}/favlists?limit=1&offset=0`, { headers: { cookie } });
        if (favlistsRes.ok) {
          const favlistsData = await favlistsRes.json();
          if (favlistsData.paging && typeof favlistsData.paging.totals === "number") {
            fav = favlistsData.paging.totals;
          }
        }
      } catch (e) {
        console.error("Failed to fetch favlists for answer", id, e);
      }
    }

    if (voteup > 0 || comment > 0 || visit > 0 || fav > 0) {
       try {
           const existing = db.prepare(`SELECT voteup_count, comment_count, favorite_count, visit_count FROM contents WHERE pk = ?`).get(pk) as any;
           if (existing) {
               if (voteup === 0 && existing.voteup_count > 0) voteup = existing.voteup_count;
               if (comment === 0 && existing.comment_count > 0) comment = existing.comment_count;
               if (fav === 0 && existing.favorite_count > 0) fav = existing.favorite_count;
               if (visit === 0 && existing.visit_count > 0) visit = existing.visit_count;
           }
           db.prepare(`UPDATE contents SET voteup_count = ?, comment_count = ?, favorite_count = ?, visit_count = ? WHERE pk = ?`).run(voteup, comment, fav, visit, pk);
       } catch (e) {
           console.error("DB update error", e);
       }
       return c.json({ data: { voteup_count: voteup, comment_count: comment, favorite_count: fav, visit_count: visit, is_deleted: 0 } });
    }
  } catch (e) {
    console.error("Live sync failed", e);
  }
  return c.json({ error: "failed" }, 500);
});

contentRoutes.post("/:pk/sync-comments-live", async c => {
  const pk = c.req.param("pk");
  const [type, id] = pk.split(":");
  if (type !== "answer") return c.json({ error: "currently only supports answer comments" }, 400);

  const cookie = process.env.ZHIHU_COOKIE_STRING || process.env.ZHIHU_COOKIE_Z_C0 || "";
  const zhihuHeaders = {
    cookie,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };
  // 与 collector 的 cleanHtml 保持一致，避免两条链路产生不同 hash 导致误报"评论更新"
  const cleanHtml = (html: any) => {
    if (typeof html !== "string") return "";
    let cleaned = html.replace(/<img([^>]*)>/g, (match: string, attrs: string) => {
       const realSrc = attrs.match(/data-(?:original|actualsrc)="([^"]+)"/);
       if (realSrc) {
          return `<img${attrs.replace(/src="[^"]+"/, `src="${realSrc[1]}"`)}>`;
       }
       return match;
    });
    cleaned = cleaned.replace(/\sdata-pid="[^"]*"/g, "");
    return cleaned;
  };
  try {
    let cOffset = 0;
    let cIsEnd = false;
    let cInterrupted = false; // 抓取中断时跳过删除检测，防止误标删除
    const allComments: any[] = [];
    
    while (!cIsEnd) {
      const cRes = await fetch(`https://www.zhihu.com/api/v4/answers/${id}/root_comments?limit=20&offset=${cOffset}`, { headers: zhihuHeaders });
      if (!cRes.ok) { cInterrupted = true; break; }
      
      const cJson = await cRes.json() as any;
      // 空 data 不一定是翻页结束（风控/异常也会返回空），只有显式 is_end 才算正常结束
      if (!cJson.data || cJson.data.length === 0) {
        if (!cJson.paging?.is_end) cInterrupted = true;
        break;
      }
      
      for (const cm of cJson.data) {
        allComments.push({
          id: String(cm.id),
          parentId: cm.reply_to_comment_id ? String(cm.reply_to_comment_id) : null,
          author: cm.author?.member?.name || "匿名",
          authorAvatar: cm.author?.member?.avatar_url || "",
          beReplied: cm.reply_to_author?.member?.name || null,
          content: cleanHtml(cm.content),
          img: "",
          time: new Date((cm.created_time || 0) * 1000).toISOString(),
          location: cm.address_text || "",
          likes: cm.vote_count || cm.reaction?.statistics?.like_count || 0,
          isAuthor: cm.is_author || cm.author?.role === "author",
          isTop: cm.top,
          isFeatured: cm.featured
        });
        
        let childComments = cm.child_comments || [];
        if (cm.child_comment_count > childComments.length) {
            let childUrl = `https://www.zhihu.com/api/v4/comments/${cm.id}/child_comments?limit=20`;
            while (childUrl) {
                try {
                    const childRes = await fetch(childUrl, { headers: zhihuHeaders });
                    if (!childRes.ok) { cInterrupted = true; break; }
                    const childJson = await childRes.json();
                    if (!childJson.data || childJson.data.length === 0) {
                      if (!childJson.paging?.is_end) cInterrupted = true;
                      break;
                    }
                    
                    for (const child of childJson.data) {
                       // Avoid duplicates if cm.child_comments had some overlapping
                       if (!allComments.find(c => c.id === String(child.id))) {
                           allComments.push({
                             id: String(child.id),
                             parentId: String(cm.id),
                             author: child.author?.member?.name || "匿名",
                             authorAvatar: child.author?.member?.avatar_url || "",
                             beReplied: child.reply_to_author?.member?.name || null,
                             content: cleanHtml(child.content),
                             img: "",
                             time: new Date((child.created_time || 0) * 1000).toISOString(),
                             location: child.address_text || "",
                             likes: child.vote_count || child.reaction?.statistics?.like_count || 0,
                             isAuthor: child.is_author || child.author?.role === "author",
                             isTop: child.top,
                             isFeatured: child.featured
                           });
                       }
                    }
                    childUrl = childJson.paging?.is_end ? "" : childJson.paging?.next;
                } catch(e) {
                    cInterrupted = true;
                    break;
                }
            }
        } else if (childComments.length > 0) {
          for (const child of childComments) {
             if (!allComments.find(c => c.id === String(child.id))) {
                 allComments.push({
                   id: String(child.id),
                   parentId: String(cm.id),
                   author: child.author?.member?.name || "匿名",
                   authorAvatar: child.author?.member?.avatar_url || "",
                   beReplied: child.reply_to_author?.member?.name || null,
                   content: cleanHtml(child.content),
                   img: "",
                   time: new Date((child.created_time || 0) * 1000).toISOString(),
                   location: child.address_text || "",
                   likes: child.vote_count || child.reaction?.statistics?.like_count || 0,
                   isAuthor: child.is_author || child.author?.role === "author",
                   isTop: child.top,
                   isFeatured: child.featured
                 });
             }
          }
        }
      }
      
      cIsEnd = cJson.paging?.is_end;
      cOffset += 20;
    }
    
    let syncStats: any = null;
    if (allComments.length > 0) {
      const { replaceComments } = await import("../services/comments.js");
      syncStats = replaceComments({ contentPk: pk, comments: allComments, partial: cInterrupted });
    }
    
    return c.json({ data: listComments(pk), sync: { ...syncStats, partial: cInterrupted } });
  } catch (e) {
    console.error("Live comments sync failed", e);
    return c.json({ error: "failed", details: String(e) }, 500);
  }
});

/**
 * 写接口统一鉴权（fail-closed）。
 * 没配 API_SECRET 直接 503，避免"以为有鉴权其实没有"。
 */
export const requireSecret = async (c: any, next: any) => {
  if (!c.env.API_SECRET) {
    console.error("API_SECRET is not configured; rejecting write request");
    return c.json({ error: "server misconfigured: API_SECRET missing" }, 503);
  }
  const auth = c.req.header("authorization");
  if (!auth || auth !== `Bearer ${c.env.API_SECRET}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

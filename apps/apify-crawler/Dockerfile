# 基础镜像 apify/actor-node-playwright:24-1.61.1（Node 24 + playwright 1.61.1，浏览器预装于 /ms-playwright）
# 版本必须与 package.json 的 playwright 精确一致（无 ^/~），否则镜像内置的
# check-playwright-version.mjs 会拒绝构建；不一致也会导致 chromium 修订号不匹配。
# 基础镜像为非 root 用户 myuser（HOME=/home/myuser），不存在 /usr/src/app——
# 以 root 属主新建 WORKDIR 会让 myuser 的 npm install 直接 EACCES。
# ---- build stage ----
FROM apify/actor-node-playwright:24-1.61.1 AS build
WORKDIR /home/myuser

# 浏览器已随基础镜像预装（PLAYWRIGHT_BROWSERS_PATH=/ms-playwright），
# 禁止 npm 生命周期脚本再下载，防止向 root 属主目录写入触发 EACCES
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --include=dev

COPY . ./
RUN npm run build

# ---- runtime stage ----
FROM apify/actor-node-playwright:24-1.61.1
WORKDIR /home/myuser

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev

COPY --from=build /home/myuser/dist ./dist

CMD ["npm", "run", "start:prod"]

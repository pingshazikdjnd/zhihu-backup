import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 读项目根目录的 .env，否则根目录的 VITE_API_BASE 对 Vite 不可见
  // （Vite 默认只从自身目录找 .env）
  envDir: path.resolve(__dirname, "../../"),
  plugins: [react()],
  server: {
    proxy: {
      // 图片备份后 HTML 里的 <img src="/api/images/{hash}.{ext}"> 是根相对路径，
      // 浏览器按页面 origin（5173）解析；把 /api/* 代理到本地 Worker（18787），
      // 让 dev 环境与生产 Pages 同源反代行为一致，图片、详情等接口都能正常命中。
      "/api": {
        target: "http://127.0.0.1:18787",
        changeOrigin: true
      }
    }
  }
});

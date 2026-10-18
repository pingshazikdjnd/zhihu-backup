import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 读项目根目录的 .env，否则根目录的 VITE_API_BASE 对 Vite 不可见
  // （Vite 默认只从自身目录找 .env）
  envDir: path.resolve(__dirname, "../../"),
  plugins: [react()]
});

import { defineConfig } from "vite";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 每次执行 `vite dev` 或 `vite build` 都会重新生成这个时间戳，并写入 public/version.json。
// 前端（src/cloudSyncUi.js）会拿它和页面自身编译时内置的 __APP_BUILD_VERSION__ 常量做比对，
// 用来检测"当前这个 PWA 窗口是不是还停留在旧代码上"——这条路径专门用来绕开 iOS 主屏幕 PWA
// 那套独立于常规 HTTP Cache-Control 的页面快照缓存机制，和数据同步逻辑完全无关。
// 用时间戳而不是内容 hash：任何一次新的构建/部署都应该被当作潜在的新版本，逻辑更简单可靠。
const buildVersion = new Date().toISOString();

writeFileSync(
  resolve(__dirname, "public/version.json"),
  JSON.stringify({ version: buildVersion }) + "\n"
);

export default defineConfig({
  define: {
    __APP_BUILD_VERSION__: JSON.stringify(buildVersion)
  },
  build: {
    target: "es2020",
    outDir: "dist"
  }
});

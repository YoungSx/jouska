import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 构建产物直接落进 ../public —— 那正是 wrangler.jsonc 里 `assets.directory`
 * 指向的目录，所以 Worker 侧的资源配置一行都不用改。
 *
 * emptyOutDir 必须开：旧的 hash 文件名不会被新构建覆盖，留着就是每次部署
 * 都把上一版的 chunk 一起传上去。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '../public'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    // `npm run dev -w @jouska/admin-panel` 起 wrangler（默认 8787），前端在
    // 5173，两个端口不同源。代理 /api 让浏览器仍视作同源，否则 Cookie 不带、
    // 服务端的同源 CSRF 校验也会把每个非 GET 请求挡掉。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});

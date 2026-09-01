import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 组件测试跑在 jsdom，跟 admin-panel 那套 Workers 池（vitest.config 同名文件在
 * 各自包根，互不干扰）彻底分开。别名沿用构建配置，测试里 `@/` 才能解析。
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});

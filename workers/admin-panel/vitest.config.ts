import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  // 这两个开关必须住在 test 键下——写在顶层会被 vitest 静默忽略。
  test: {
    // Timing-sensitive tests (PBKDF2 CPU budget) and shared Miniflare state both
    // want controlled conditions: run files one at a time.
    fileParallelism: false,
    // Workers 池只收 Workers 侧的用例。默认 glob 会连 web/ 一起捞——那是
    // jsdom 组件测试的地盘（web 包自带 vitest 配置），塞进 workerd 只会崩。
    include: ['src/**/*.test.ts'],
  },
  // Migrations are read in Node (the test runtime has no filesystem) and
  // injected as a compile-time constant for `applyD1Migrations`.
  define: {
    TEST_MIGRATIONS: JSON.stringify(await readD1Migrations('./migrations')),
  },
});

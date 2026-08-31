import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  // Timing-sensitive tests (PBKDF2 CPU budget) and shared Miniflare state both
  // want controlled conditions: run files one at a time.
  fileParallelism: false,
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  // Migrations are read in Node (the test runtime has no filesystem) and
  // injected as a compile-time constant for `applyD1Migrations`.
  define: {
    TEST_MIGRATIONS: JSON.stringify(await readD1Migrations('./migrations')),
  },
});

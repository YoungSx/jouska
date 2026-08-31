import type { KVNamespace } from '@cloudflare/workers-types';

/** Bindings from wrangler.jsonc. */
export interface Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  ASSETS: Fetcher;
  /**
   * Absolute origin this panel is deployed at, when served behind a proxy
   * that rewrites Host. Optional; the Origin check falls back to Host.
   */
  PANEL_URL?: string;
}

/** Hono variables set by the auth middleware. */
export interface Vars {
  user: { userId: number; subject: string; role: 'admin' | 'viewer' };
}

export type AppEnv = { Bindings: Env; Variables: Vars };

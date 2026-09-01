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

  /**
   * Script name of the reverse proxy Worker whose hostnames are discovered.
   *
   * The panel and the proxy are separate Workers, and it is the *proxy's*
   * hostnames that `match.host` is written against — the panel's own are
   * irrelevant to routing. Defaults to `jouska`, the name in the reference
   * proxy's wrangler.jsonc.
   */
  PROXY_SCRIPT_NAME?: string;

  /**
   * Cloudflare account id, for hostname discovery. Not a secret.
   *
   * Optional: without it the panel simply cannot look hostnames up, and says
   * so. Every other feature works.
   */
  CF_ACCOUNT_ID?: string;

  /**
   * Read-only Cloudflare API token, for hostname discovery. A secret.
   *
   * Set with `wrangler secret put CF_API_TOKEN`. Wants only read scopes —
   * `Workers Scripts Read` answers the workers.dev and Custom Domain
   * questions; adding `Zone Read` + `Workers Routes Read` answers the route
   * one. A token with write scopes would let a panel compromise reconfigure
   * the account, so the narrow one is the point.
   */
  CF_API_TOKEN?: string;
}

/** Hono variables set by the auth middleware. */
export interface Vars {
  user: { userId: number; subject: string; role: 'admin' | 'viewer' };
}

export type AppEnv = { Bindings: Env; Variables: Vars };

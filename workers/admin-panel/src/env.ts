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
   * Cloudflare Access team name — the `<team>` in `<team>.cloudflareaccess.com`.
   *
   * Setting this and `ACCESS_AUD` together is what turns Access login on. Both
   * or neither: a team without an audience would verify that the token was
   * signed by the right organisation but not that it was issued for *this*
   * application, and any other app in the same team could then let a caller in.
   *
   * Not a secret — it names a public JWKS endpoint.
   */
  ACCESS_TEAM?: string;

  /**
   * Audience (AUD) tag of the Access application in front of this panel.
   *
   * Read it off the Access application in the Zero Trust dashboard. Not a
   * secret either; it is a public identifier that appears in every token.
   */
  ACCESS_AUD?: string;

  /**
   * Standing policy for addresses Access admits that `users` has never heard
   * of: `admin` or `viewer` gives them a row with that role on arrival, while
   * unset (and anything else — a typo must fail closed, not softly) keeps the
   * founding posture of refusing unknown addresses and adding people from the
   * users screen. Not a secret; a repo-level policy choice, which is why it
   * lives in wrangler.jsonc rather than CI secrets — tightening it is a
   * reviewed change, not a silent one. Whatever it says, the first caller
   * through an empty table still bootstraps as admin: an out-of-band wipe is
   * recovery, never a permanent lockout.
   */
  ACCESS_PROVISION_ROLE?: string;

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

  /**
   * Build identity of this deployment, injected by CI as a plain var
   * (`--var BUILD_ID:...` from `git describe --tags --always --dirty`). Not a
   * secret — it names the commit the Worker was built from, and it is exactly
   * what the refusal screens report: when someone cannot get in, the version
   * of the thing refusing them is the one diagnostic they can still see.
   * Local dev leaves it unset; the endpoints then answer 'dev'.
   */
  BUILD_ID?: string;
}

/** Hono variables set by the auth middleware. */
export interface Vars {
  user: {
    userId: number;
    subject: string;
    role: 'admin' | 'viewer';
  };
}

export type AppEnv = { Bindings: Env; Variables: Vars };

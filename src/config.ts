import { z } from 'zod';

/**
 * Declarative route table. One request resolves to exactly one upstream:
 * Workers allows only 6 concurrent outbound connections per request, so
 * fan-out / racing upstreams is deliberately not expressible here.
 */

const hostnameOrWildcard = z
  .string()
  .min(1)
  .regex(/^\*?[a-z0-9.-]+$/i, 'expected a hostname, optionally prefixed with "*"');

/** Upstream target: `host` or `host/base/path`. No scheme, no query. */
const upstream = z
  .string()
  .min(1)
  .regex(/^[a-z0-9.-]+(:\d+)?(\/[^?#\s]*)?$/i, 'expected "host" or "host/base/path"')
  .refine((v) => !v.includes('//'), 'must not contain a scheme');

const match = z
  .object({
    /** Matches the request Host header. `*.example.com` matches subdomains. */
    host: hostnameOrWildcard.optional(),
    /** Path prefix, e.g. `/openai`. Matched on segment boundaries. */
    path: z.string().startsWith('/').optional(),
    methods: z.array(z.string().min(1)).nonempty().optional(),
  })
  .refine((m) => m.host !== undefined || m.path !== undefined, {
    message: 'a route must match on host, path, or both',
  });

const bodyRewrite = z.object({
  /** Replace occurrences of upstream hostnames with the proxy hostname. */
  rewriteLinks: z.boolean().default(true),
  /** Extra literal string replacements applied to text bodies. */
  replace: z.array(z.object({ from: z.string().min(1), to: z.string() })).default([]),
  /** Content types eligible for rewriting. Prefix match against content-type. */
  contentTypes: z.array(z.string().min(1)).default(['text/html']),
});

/**
 * CORS is delegated to `hono/cors`; these fields mirror its options. `origin`
 * defaults to reflecting the caller so credentialed requests work: the spec
 * forbids `*` alongside `Access-Control-Allow-Credentials`, and browsers reject
 * the whole response when both appear.
 */
const cors = z.object({
  /** Allowed origins. Omit to reflect whatever origin the caller sent. */
  origins: z.array(z.string().min(1)).nonempty().optional(),
  allowMethods: z.array(z.string().min(1)).nonempty().optional(),
  allowHeaders: z.array(z.string().min(1)).default([]),
  exposeHeaders: z.array(z.string().min(1)).default([]),
  credentials: z.boolean().default(false),
  maxAge: z.number().int().nonnegative().optional(),
});

/** IP rules are delegated to `hono/ip-restriction`; entries may be IPs or CIDRs. */
const ipRules = z
  .object({
    allow: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
  })
  .refine((r) => r.allow.length > 0 || r.deny.length > 0, {
    message: 'ip requires at least one allow or deny entry',
  });

/**
 * Rate limiting uses Cloudflare's native binding, so no KV or Durable Object is
 * involved. Counting is per-location rather than globally exact, which is the
 * documented trade-off and is adequate for abuse control.
 */
const rateLimit = z.object({
  /** Name of the `ratelimit` binding in wrangler config. */
  binding: z.string().min(1),
  /** What to count by. `ip` is the common choice; `route` limits the whole route. */
  by: z.enum(['ip', 'path', 'route']).default('ip'),
});

const route = z.object({
  /**
   * Stable handle for this route. Only needed when merging a code-defined table
   * with a remote one: same id means the code version wins. Routes without an
   * id are never merged, only appended.
   */
  id: z.string().min(1).optional(),
  match,
  upstream,
  /** Strip the matched path prefix before forwarding. */
  stripPrefix: z.boolean().default(false),
  /** Per-attempt upstream deadline. */
  timeoutMs: z.number().int().positive().max(30_000).default(10_000),
  /** Extra attempts after the first failure. Only idempotent methods retry. */
  retries: z.number().int().min(0).max(3).default(0),
  /** Rewrite Location / Set-Cookie so redirects and cookies stay on the proxy. */
  rewriteHeaders: z.boolean().default(true),
  /** Streaming body rewrite. Omit to disable. */
  bodyRewrite: bodyRewrite.optional(),
  /** ISO 3166-1 alpha-2 codes refused with 403. */
  blockCountries: z.array(z.string().length(2)).default([]),
  /** Headers injected into the upstream request. */
  upstreamHeaders: z.record(z.string(), z.string()).default({}),
  /** CORS handling. Omit to leave the upstream's own CORS headers untouched. */
  cors: cors.optional(),
  /** IP allow/deny rules. Omit to admit every address. */
  ip: ipRules.optional(),
  /** Rate limiting via the native Cloudflare binding. Omit to disable. */
  rateLimit: rateLimit.optional(),
});

/**
 * Wire-format version of the config document.
 *
 * This exists so a stored config written by an older (or newer) version of
 * veilo is recognised rather than silently reinterpreted. Without it, a future
 * change to the route shape would make an old document parse into something
 * subtly different instead of failing loudly.
 *
 * Bump this only for changes an older reader cannot handle. Adding an optional
 * field is backward compatible and does not need a bump.
 */
export const CONFIG_VERSION = 1;

/**
 * Provenance for a stored config document: who wrote it and when.
 *
 * Written by whatever wrote the document (typically an admin panel) and carried
 * through unchanged. Deliberately inert — no proxying decision reads these
 * fields, because config that quietly changes behaviour is a hidden control
 * surface. It exists so an operator can answer "who changed this and when"
 * without a separate lookup.
 */
const meta = z.object({
  /** ISO 8601 timestamp of the write. */
  updatedAt: z.string().min(1).optional(),
  /** Identifier of whoever made the change, in whatever form the writer uses. */
  updatedBy: z.string().min(1).optional(),
  /** Monotonic counter or content hash, for the writer's own change tracking. */
  revision: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
  /** Free-form note, e.g. a change reason. */
  note: z.string().optional(),
});

export const configSchema = z.object({
  /**
   * Omitted means version 1, so documents written before versioning existed
   * stay valid and hand-written configs need not carry boilerplate.
   */
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  /** Optional provenance. Validated for shape, then carried through untouched. */
  meta: meta.optional(),
  routes: z.array(route).nonempty(),
});

export type Config = z.output<typeof configSchema>;
export type Route = z.output<typeof route>;
export type ConfigMeta = z.output<typeof meta>;
export type CorsConfig = z.output<typeof cors>;
export type RateLimitConfig = z.output<typeof rateLimit>;
export type RouteInput = z.input<typeof route>;
export type ConfigInput = z.input<typeof configSchema>;

/** Validates and applies defaults. Throws `z.ZodError` on invalid input. */
export const defineConfig = (input: ConfigInput): Config => configSchema.parse(input);

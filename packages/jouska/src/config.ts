import { z } from 'zod';

/**
 * Declarative route table. One request resolves to exactly one upstream:
 * Workers allows only 6 concurrent outbound connections per request, so
 * fan-out / racing upstreams is deliberately not expressible here.
 *
 * Normalisation happens here rather than at match time. A config value that is
 * merely mis-cased must not silently stop working — `blockCountries: ['cu']`
 * failing open is the worst possible failure mode for a security control — so
 * every case-insensitive field is lowercased (or uppercased) by the schema and
 * the matching code can then compare exactly.
 */

/**
 * A hostname, optionally prefixed with `*.` to match subdomains.
 *
 * The dot is mandatory: `*example.com` would otherwise match `evilexample.com`,
 * which reads like a subdomain rule but is an entirely different registrant.
 * Verified against workerd: the old pattern admitted that string and matched it.
 */
const hostnameOrWildcard = z
  .string()
  .min(1)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
    'expected a hostname, optionally prefixed with "*." to match subdomains',
  )
  // Hosts are compared case-insensitively, so store one canonical form and let
  // the matcher compare exactly. Without this a wildcard pattern written with
  // capitals silently matched nothing.
  .transform((v) => v.toLowerCase());

/**
 * Hostnames that must never be an upstream.
 *
 * The upstream can be changed at runtime through KV, which makes it a request
 * forgery surface: a proxy that will fetch any host an operator types is one
 * corrupted config away from being an internal port scanner. Cloud metadata
 * endpoints are the sharpest case — verified from workerd, a fetch to
 * 169.254.169.254 completes rather than being blocked by the platform.
 *
 * This is a denylist of literal addresses, not a general private-range check:
 * an upstream given as a DNS name can still resolve to a private address, and
 * no amount of parsing at config time can see that.
 *
 * Nothing downstream makes up for that. Verified against workerd: the platform
 * does not filter private egress — a fetch to 169.254.169.254 answers 404, and
 * 10.0.0.1 times out rather than being refused. Nor can the gap be closed here:
 * resolving the name first and then pinning the address is impossible, because
 * `fetch` offers no way to direct a request at a chosen IP while keeping the
 * hostname for TLS. So a DNS name that resolves to a private address at request
 * time is an accepted limitation of running on Workers, not something this
 * check merely defers. What it does cover is every literal form, which is what
 * a mistyped or tampered config looks like.
 */
const FORBIDDEN_UPSTREAM_HOSTS = new Set([
  // Loopback. Numeric forms are caught by range check, these are the names.
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  // Cloud metadata endpoints reachable by name.
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * Whether a literal IPv4 address falls in a range that is never routable
 * publicly. Takes the four octets, so the caller has already normalised.
 */
const isPrivateIPv4 = (octets: readonly number[]): boolean => {
  if (octets.length !== 4) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8, which routes to the local host
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16, including cloud metadata
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10, carrier NAT
    a >= 224 // multicast and reserved
  );
};

/**
 * Resolves a host to the form a `fetch` would actually connect to.
 *
 * This has to go through the URL parser rather than pattern-matching the string.
 * An IPv4 address has several spellings that all normalise to the same address —
 * `127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1` — and checking only
 * dotted-quad form let every one of them through. Verified against workerd:
 * `new URL('https://2852039166/')` has hostname `169.254.169.254`, the cloud
 * metadata endpoint. Asking the parser is the only check that agrees with what
 * the runtime will do.
 */
const canonicalHost = (host: string): string | undefined => {
  try {
    // A bare host is not a URL, so give it a scheme to parse against.
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** Whether a host, once canonicalised, is one no upstream should point at. */
const isForbiddenHost = (host: string): boolean => {
  const canonical = canonicalHost(host) ?? host.toLowerCase();
  // A trailing dot is the fully-qualified form of the same name.
  const bare = canonical.replace(/\.$/, '');
  if (FORBIDDEN_UPSTREAM_HOSTS.has(bare)) {
    return true;
  }
  // IPv6 needs no branch here: the `upstream` pattern admits neither brackets
  // nor a bare `::`, so a literal address reaches this function in dotted-quad
  // form or not at all. There used to be a check for `::1`, `fe80:` and `fc`/`fd`
  // prefixes; it was unreachable, and reachable it would have been worse than
  // nothing, since it saw none of `::ffff:127.0.0.1`, `64:ff9b::a9fe:a9fe`,
  // `2002:7f00:1::` or `2001:0::` — the mapped, NAT64, 6to4 and Teredo spellings
  // of exactly the addresses it meant to refuse. Refusing every IPv6 literal at
  // the pattern is the position that can be proved.
  const parts = bare.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) {
    return false;
  }
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) && isPrivateIPv4(octets);
};

/**
 * Upstream target: `host`, `host:port`, or `host/base/path`. No scheme — the
 * scheme is a separate route field, because embedding it here would make the
 * value ambiguous with a path (`//` is both a scheme separator and an empty
 * first segment).
 *
 * IPv6 literals are refused: the pattern allows no brackets and no `:` outside a
 * numeric port. That is deliberate. Classifying an IPv6 address as private takes
 * prefix arithmetic over the mapped, NAT64, 6to4 and Teredo forms, and a partial
 * attempt at it would admit the loopback and metadata addresses it was written
 * to exclude. An IPv6-only upstream must therefore be reached by name.
 */
const upstream = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[^?#\s]*)?$/i,
    'expected "host", "host:port" or "host/base/path" without a scheme',
  )
  .refine((v) => !v.includes('//'), 'must not contain a scheme')
  .transform((v) => {
    // Lowercase the host but not the base path: paths are case-sensitive.
    const slash = v.indexOf('/');
    const authority = slash === -1 ? v : v.slice(0, slash);
    const base = slash === -1 ? '' : v.slice(slash);
    return `${authority.toLowerCase()}${base}`;
  })
  .superRefine((v, ctx) => {
    const host = v.split('/')[0]!.split(':')[0]!;
    if (isForbiddenHost(host)) {
      ctx.addIssue({
        code: 'custom',
        message: `upstream "${host}" resolves to a loopback, private or metadata address; set allowPrivateUpstream on the route to permit it`,
      });
    }
  });

/**
 * Same shape as `upstream` but without the private-address refusal, for the
 * routes that opt in. Kept as a separate schema rather than a flag threaded
 * through a refinement, because Zod cannot see a sibling field from inside one.
 */
const upstreamAllowingPrivate = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[^?#\s]*)?$/i,
    'expected "host", "host:port" or "host/base/path" without a scheme',
  )
  .refine((v) => !v.includes('//'), 'must not contain a scheme')
  .transform((v) => {
    const slash = v.indexOf('/');
    const authority = slash === -1 ? v : v.slice(0, slash);
    const base = slash === -1 ? '' : v.slice(slash);
    return `${authority.toLowerCase()}${base}`;
  });

/** HTTP methods, uppercased so matching is an exact comparison. */
const methods = z
  .array(
    z
      .string()
      .min(1)
      .regex(/^[a-z]+$/i, 'expected an HTTP method name')
      .transform((m) => m.toUpperCase()),
  )
  .nonempty();

const match = z
  .object({
    /** Matches the request host. `*.example.com` matches subdomains, not the apex. */
    host: hostnameOrWildcard.optional(),
    /** Path prefix, e.g. `/openai`. Matched on segment boundaries. */
    path: z.string().startsWith('/').optional(),
    methods: methods.optional(),
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
  /**
   * Also rewrite hosts inside `<style>` blocks, inline `style` attributes and
   * `<meta http-equiv="refresh">`. On by default: a mirrored site whose CSS
   * still points at the origin loads its backgrounds from the upstream, which
   * both leaks the origin and breaks when the origin blocks hotlinking.
   */
  rewriteStyles: z.boolean().default(true),
  /**
   * Charset to assume when the upstream declares nothing, or declares a label
   * this runtime cannot decode. Left undefined, such a body passes through
   * untouched rather than being mangled — verified against workerd, decoding
   * GB2312 bytes as UTF-8 turns every multi-byte character into U+FFFD.
   *
   * A fallback this runtime cannot decode either leaves the body untouched too,
   * rather than silently standing in UTF-8 for the charset that was asked for.
   */
  fallbackCharset: z.string().min(1).optional(),
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
  allowMethods: methods.optional(),
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
  /**
   * Whether a CORS preflight consumes budget. Off by default: a browser issues
   * one preflight per cross-origin call, so counting both halves the effective
   * limit for exactly the callers who are behaving correctly.
   */
  countPreflight: z.boolean().default(false),
});

/**
 * ISO 3166-1 alpha-2 country code, uppercased.
 *
 * Cloudflare reports `cf.country` in uppercase, plus `T1` for Tor. Normalising
 * here is what stops `blockCountries: ['cu']` from silently admitting every
 * request — verified against workerd, the previous schema accepted it and the
 * comparison then never matched.
 */
const countryCode = z
  .string()
  .length(2)
  .regex(/^[a-z]{2}$/i, 'expected an ISO 3166-1 alpha-2 country code')
  .transform((v) => v.toUpperCase());

/**
 * An HTTP header name, validated as an RFC 9110 token.
 *
 * Checked here rather than at forward time because `Headers.set` throws on an
 * invalid name, and that throw surfaced as `502 upstream_unreachable` — a
 * configuration mistake disguised as an upstream fault, which sends whoever is
 * debugging it in entirely the wrong direction.
 */
const headerName = z
  .string()
  .min(1)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'expected a valid HTTP header name (RFC 9110 token)');

/** Headers a route may not inject: jouska derives these from the request itself. */
const RESERVED_UPSTREAM_HEADERS = new Set([
  'host',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
]);

/**
 * Header map injected into the upstream request.
 *
 * Names are validated, and the four forwarding headers are refused outright.
 * Previously they were silently overwritten by jouska's own values (correct, but
 * only because of where the spread happened) — a config that cannot take effect
 * should say so rather than appear to work.
 */
const upstreamHeaderMap = z.record(headerName, z.string()).superRefine((headers, ctx) => {
  for (const name of Object.keys(headers)) {
    if (RESERVED_UPSTREAM_HEADERS.has(name.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        message: `upstreamHeaders may not set "${name}": jouska derives it from the request`,
      });
    }
  }
});

const upstreamHeaders = upstreamHeaderMap.default({});

/** Fields shared by a route and the table-wide `defaults` block. */
const routeBehaviour = {
  /** Scheme used to reach the upstream. `http` is for local and in-network origins. */
  scheme: z.enum(['https', 'http']).default('https'),
  /** Strip the matched path prefix before forwarding. */
  stripPrefix: z.boolean().default(false),
  /** Per-attempt upstream deadline. */
  timeoutMs: z.number().int().positive().max(30_000).default(10_000),
  /**
   * Ceiling on all attempts combined, including backoff.
   *
   * Without this, `retries: 3` with `timeoutMs: 30000` lets a single request
   * occupy the proxy for two minutes before returning 504 — measured at 403ms
   * for 4×100ms attempts, so the arithmetic holds in practice.
   */
  totalTimeoutMs: z.number().int().positive().max(60_000).default(30_000),
  /** Extra attempts after the first failure. Only idempotent methods retry. */
  retries: z.number().int().min(0).max(3).default(0),
  /**
   * Delay before the first retry, doubled for each subsequent one.
   *
   * Retrying with no delay was measured at a 0–1ms gap, which is long enough
   * for nothing: a transient upstream failure is almost certain to still be
   * failing. Set to 0 to restore the immediate-retry behaviour.
   */
  retryBackoffMs: z.number().int().min(0).max(5_000).default(100),
  /** Rewrite Location / Set-Cookie so redirects and cookies stay on the proxy. */
  rewriteHeaders: z.boolean().default(true),
  /**
   * Ask the runtime for the redirect rather than following it upstream.
   *
   * On by default because it is the only way `Location` rewriting can be
   * observed: verified against the real network, `fetch` follows redirects
   * itself, so with this off the visitor silently lands on the upstream origin
   * and the rewrite never runs.
   */
  manualRedirect: z.boolean().default(true),
  /**
   * Forward WebSocket upgrades. On by default; a proxy that drops them turns a
   * working socket into a plain 200 with no diagnostic.
   */
  websocket: z.boolean().default(true),
  /** ISO 3166-1 alpha-2 codes refused with 403. */
  blockCountries: z.array(countryCode).default([]),
  /**
   * When set, only these countries are admitted. Applied after `blockCountries`,
   * and a request with no country signal is refused — an allow-list that fails
   * open is not an allow-list.
   */
  allowCountries: z.array(countryCode).nonempty().optional(),
  /** Headers injected into the upstream request. */
  upstreamHeaders,
  /** Streaming body rewrite. Omit to disable. */
  bodyRewrite: bodyRewrite.optional(),
  /** CORS handling. Omit to leave the upstream's own CORS headers untouched. */
  cors: cors.optional(),
  /** IP allow/deny rules. Omit to admit every address. */
  ip: ipRules.optional(),
  /** Rate limiting via the native Cloudflare binding. Omit to disable. */
  rateLimit: rateLimit.optional(),
} as const;

const route = z.object({
  /**
   * Stable handle for this route. Used to merge a code-defined table with a
   * remote one (same id means the code version wins) and, when present, to
   * namespace rate-limit buckets. Routes without an id are never merged.
   */
  id: z.string().min(1).optional(),
  match,
  upstream,
  /**
   * Permit a loopback, private or metadata upstream. Off by default: the
   * upstream is runtime-editable through KV, so an unconstrained value turns a
   * corrupted config into an internal network probe.
   */
  allowPrivateUpstream: z.literal(true).optional(),
  ...routeBehaviour,
});

/**
 * A route that has opted out of the private-upstream refusal. Parsed as a
 * separate branch because Zod cannot consult a sibling field from within the
 * refinement that would need it.
 */
const privateRoute = route.extend({
  upstream: upstreamAllowingPrivate,
  allowPrivateUpstream: z.literal(true),
});

/**
 * Table-wide defaults, applied to every route that does not state its own value.
 *
 * Without this, a table of twenty routes repeats `timeoutMs` twenty times and
 * the twenty-first is forgotten. Every field is optional; only those present
 * are applied.
 */
const defaults = z
  .object({
    scheme: routeBehaviour.scheme.removeDefault().optional(),
    stripPrefix: routeBehaviour.stripPrefix.removeDefault().optional(),
    timeoutMs: routeBehaviour.timeoutMs.removeDefault().optional(),
    totalTimeoutMs: routeBehaviour.totalTimeoutMs.removeDefault().optional(),
    retries: routeBehaviour.retries.removeDefault().optional(),
    retryBackoffMs: routeBehaviour.retryBackoffMs.removeDefault().optional(),
    rewriteHeaders: routeBehaviour.rewriteHeaders.removeDefault().optional(),
    manualRedirect: routeBehaviour.manualRedirect.removeDefault().optional(),
    websocket: routeBehaviour.websocket.removeDefault().optional(),
    blockCountries: routeBehaviour.blockCountries.removeDefault().optional(),
    allowCountries: routeBehaviour.allowCountries,
    // The un-defaulted schema, not `upstreamHeaders.removeDefault()`: that
    // returns the inner record and drops the refinement, so a reserved header
    // written here was accepted and then folded into every route — validated in
    // one place and silently ignored in the other.
    upstreamHeaders: upstreamHeaderMap.optional(),
    bodyRewrite: routeBehaviour.bodyRewrite,
    cors: routeBehaviour.cors,
    ip: routeBehaviour.ip,
    rateLimit: routeBehaviour.rateLimit,
  })
  .optional();

/**
 * Wire-format version of the config document.
 *
 * This exists so a stored config written by an older (or newer) version of
 * jouska is recognised rather than silently reinterpreted. Without it, a future
 * change to the route shape would make an old document parse into something
 * subtly different instead of failing loudly.
 *
 * Bump this only for changes an older reader cannot handle. Adding an optional
 * field is backward compatible and does not need a bump — every field added in
 * this revision is optional or defaulted, so version 1 documents stay valid.
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

/**
 * A route, in either of its two shapes. The private-upstream branch is tried
 * first so its more permissive `upstream` applies when the flag is set; without
 * the flag the strict branch runs and refuses private addresses.
 */
const anyRoute = z.union([privateRoute, route]);

/**
 * Field carrying, per route, the keys that route stated explicitly.
 *
 * The capture has to happen before Zod fills in any default: once the route is
 * parsed, every defaulted field is present and indistinguishable from one the
 * author wrote out, and comparing against the schema default is no substitute —
 * that would silently override a route which deliberately restated it.
 *
 * It travels as a declared field because `z.object` strips anything it does not
 * declare, symbol keys included. Preprocessing always overwrites it, so a value
 * supplied by a caller (or a stored document) cannot influence anything.
 */
const STATED_KEYS_FIELD = '__jouskaStatedKeys';

/** Records each route's own keys, then hands the document on unchanged. */
const captureStatedKeys = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null) {
    return input;
  }
  const doc = input as Record<string, unknown>;
  if (!Array.isArray(doc.routes)) {
    return input;
  }
  return {
    ...doc,
    [STATED_KEYS_FIELD]: doc.routes.map((entry) =>
      typeof entry === 'object' && entry !== null ? Object.keys(entry as object) : [],
    ),
  };
};

const documentSchema = z.object({
  /**
   * Omitted means version 1, so documents written before versioning existed
   * stay valid and hand-written configs need not carry boilerplate.
   */
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  /** Optional provenance. Validated for shape, then carried through untouched. */
  meta: meta.optional(),
  /** Values applied to any route that does not state its own. */
  defaults,
  routes: z.array(anyRoute).nonempty(),
  /** Internal: populated by preprocessing, never authored. */
  [STATED_KEYS_FIELD]: z.array(z.array(z.string())).optional(),
});

type RouteOutput = z.output<typeof route>;
type DefaultsOutput = z.output<typeof defaults>;

/**
 * Folds `defaults` into each route.
 *
 * A key the route did not state takes the table-wide value; a key it did state
 * keeps its own. `defaults` therefore fills gaps and never overrides.
 */
const applyDefaults = (
  routes: readonly RouteOutput[],
  statedKeys: readonly (readonly string[])[] | undefined,
  tableDefaults: DefaultsOutput,
): RouteOutput[] => {
  if (tableDefaults === undefined) {
    return [...routes];
  }
  const entries = Object.entries(tableDefaults).filter(([, value]) => value !== undefined);
  return routes.map((parsed, index) => {
    const stated = new Set(statedKeys?.[index] ?? Object.keys(parsed));
    const merged = { ...parsed } as Record<string, unknown>;
    for (const [key, value] of entries) {
      if (!stated.has(key)) {
        merged[key] = value;
      }
    }
    return merged as RouteOutput;
  });
};

export const configSchema = z.preprocess(captureStatedKeys, documentSchema).transform((doc) => ({
  version: doc.version,
  ...(doc.meta !== undefined ? { meta: doc.meta } : {}),
  routes: applyDefaults(doc.routes, doc[STATED_KEYS_FIELD], doc.defaults) as [
    RouteOutput,
    ...RouteOutput[],
  ],
}));

export type Config = {
  version: typeof CONFIG_VERSION;
  meta?: z.output<typeof meta>;
  routes: [RouteOutput, ...RouteOutput[]];
};
export type Route = RouteOutput;
export type ConfigMeta = z.output<typeof meta>;
export type CorsConfig = z.output<typeof cors>;
export type RateLimitConfig = z.output<typeof rateLimit>;
export type BodyRewriteConfig = z.output<typeof bodyRewrite>;
export type RouteInput = z.input<typeof anyRoute>;
/** Input shape, minus the internal bookkeeping field preprocessing supplies. */
export type ConfigInput = Omit<z.input<typeof documentSchema>, typeof STATED_KEYS_FIELD>;

/** Validates and applies defaults. Throws `z.ZodError` on invalid input. */
export const defineConfig = (input: ConfigInput): Config => configSchema.parse(input) as Config;

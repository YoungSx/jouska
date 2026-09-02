import { z } from 'zod';

import { HOP_BY_HOP } from './internal/hop.js';

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

/**
 * Request headers a route may neither write nor delete.
 *
 * Three groups, refused for three different reasons:
 *
 *  - **Forwarding identity.** `host` and the `x-forwarded-*` trio are derived
 *    from the request. They used to be silently overwritten by jouska's own
 *    values afterwards — correct, but only because of where the spread happened
 *    — and a config that cannot take effect should say so rather than appear to
 *    work.
 *  - **Transport framing.** The hop-by-hop set and `content-length` describe this
 *    one connection; the runtime owns them, so a value written here is either
 *    discarded or corrupts the request. `transfer-encoding` is the sharpest case,
 *    since a forged one is where request smuggling starts.
 *  - **Negotiation jouska has already settled.** `accept-encoding` is deleted so
 *    bodies arrive uncompressed, which is the entire basis of streaming body
 *    rewriting: writing it back would leave the rewriter scanning compressed
 *    bytes and silently doing nothing. The WebSocket handshake headers are
 *    governed by the `websocket` flag, and writing them back would let an upgrade
 *    through on a route that turned it off.
 *
 * Deletion is refused alongside writing for all of them: removing a header
 * jouska is about to write is dead configuration, and dead configuration that
 * reads as live is what this schema exists to prevent.
 */
const RESERVED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  ...HOP_BY_HOP,
  'content-length',
  'accept-encoding',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]);

/**
 * Response headers a route may neither write nor delete.
 *
 * The hop-by-hop set, `content-length` and `content-encoding` describe how the
 * body reached this hop, and the runtime recomputes them for the hop out. Writing
 * one hands the client a length or an encoding label that does not describe the
 * bytes it is about to read.
 *
 * `set-cookie` is here rather than among the merely-undeletable names because
 * `Headers.set` replaces *every* value under a name: writing one cookie discards
 * all of the upstream's. That makes writing it a superset of deleting it, so a
 * rule that refused only the deletion would not hold.
 */
const RESERVED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP,
  'content-length',
  'content-encoding',
  'set-cookie',
]);

/**
 * Response headers a route may write but not delete.
 *
 * These are the ones the proxy rewrote to keep the visitor on it. Deleting
 * `location` makes a redirect vanish; deleting `content-location` or `refresh`
 * loses the same rewrite more quietly. Writing them stays permitted — the
 * asymmetry is deliberate and documented in the README: a written value is a
 * decision someone made, whereas a deletion reads like tidying up and would
 * silently remove behaviour the proxy depends on.
 */
const REWRITTEN_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'location',
  'content-location',
  'refresh',
]);

/**
 * Checks the names in a header map, returning problems as messages rather than
 * touching Zod's context, so one implementation serves `requestHeaders.set`,
 * `responseHeaders.set` and the legacy `upstreamHeaders` alias. Sharing it is the
 * point: an alias that validated less would be a way around the refusals.
 *
 * The case check is not pedantry. Header names are case-insensitive, so `X-Foo`
 * and `x-foo` in one map are a single rule with two values, and which one
 * survives depends on key insertion order — something no reader of the document
 * could predict.
 */
const inspectHeaderNames = (
  names: readonly string[],
  field: string,
  reserved: ReadonlySet<string>,
): { canonical: Map<string, string>; problems: string[] } => {
  const canonical = new Map<string, string>();
  const problems: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const first = canonical.get(lower);
    if (first !== undefined) {
      problems.push(
        `${field} names both "${first}" and "${name}", which are one header: ` +
          `names are case-insensitive, so which value survived would depend on key order`,
      );
      continue;
    }
    canonical.set(lower, name);
    if (reserved.has(lower)) {
      problems.push(
        `${field} may not write "${name}": the proxy derives it or the runtime ` +
          `owns it — see the README's header rules table`,
      );
    }
  }
  return { canonical, problems };
};

/**
 * Declarative header rules for one direction: names to write, names to delete.
 *
 * Deliberately not a callback. The route table lives in a store and is edited
 * from a panel, so an `onRequest` / `onResponse` hook — which is how the project
 * this was forked from solves the same problem — would mean "anyone who can edit
 * the route table can run arbitrary code in the Worker". Two operations cover
 * what operators actually reach for (inject an API version, strip a leaking
 * `Server`) and open no such surface.
 *
 * Values are literal strings. There is no interpolation: `${host}` would be a
 * second grammar with its own escaping rules, and credentials belong in Secrets
 * Store rather than in a route table that a panel can display.
 */
const headerRuleShape = z.object({
  /** Headers written onto the message, replacing any value already present. */
  set: z.record(headerName, z.string()).default({}),
  /** Headers deleted from the message. */
  remove: z.array(headerName).default([]),
});

/** Builds the rules schema for one direction, with that direction's refusals. */
const headerRules = (
  field: 'requestHeaders' | 'responseHeaders',
  noWrite: ReadonlySet<string>,
  noDelete: ReadonlySet<string>,
) =>
  headerRuleShape
    .superRefine((rules, ctx) => {
      const { canonical, problems } = inspectHeaderNames(
        Object.keys(rules.set),
        `${field}.set`,
        noWrite,
      );
      for (const message of problems) {
        ctx.addIssue({ code: 'custom', path: ['set'], message });
      }
      for (const name of rules.remove) {
        const lower = name.toLowerCase();
        if (noDelete.has(lower)) {
          ctx.addIssue({
            code: 'custom',
            path: ['remove'],
            message:
              `${field}.remove may not delete "${name}": the proxy depends on it ` +
              `— see the README's header rules table`,
          });
        }
        if (canonical.has(lower)) {
          ctx.addIssue({
            code: 'custom',
            path: ['remove'],
            message: `${field} both writes and deletes "${name}"; state one or the other`,
          });
        }
      }
    })
    // One canonical spelling is stored so the runtime applies exactly what it
    // compared, and duplicates in `remove` collapse instead of being deleted
    // twice. Safe because `Headers` is case-insensitive on both operations.
    .transform((rules) => ({
      set: Object.fromEntries(
        Object.entries(rules.set).map(([name, value]) => [name.toLowerCase(), value]),
      ),
      remove: [...new Set(rules.remove.map((name) => name.toLowerCase()))],
    }));

const requestHeaderRules = headerRules(
  'requestHeaders',
  RESERVED_REQUEST_HEADERS,
  RESERVED_REQUEST_HEADERS,
);

const responseHeaderRules = headerRules(
  'responseHeaders',
  RESERVED_RESPONSE_HEADERS,
  new Set([...RESERVED_RESPONSE_HEADERS, ...REWRITTEN_RESPONSE_HEADERS]),
);

/**
 * Legacy alias for `requestHeaders.set`, accepted so a route table written
 * before `requestHeaders` existed keeps working.
 *
 * It is folded into `requestHeaders.set` once `defaults` have been applied, and
 * does not survive into the parsed route: exactly one field reaches the
 * forwarding code, so "both fields exist and each half takes effect" is not a
 * state that can occur. See {@link foldUpstreamHeaders} for what happens when a
 * name appears in both.
 */
const upstreamHeaderMap = z
  .record(headerName, z.string())
  .superRefine((headers, ctx) => {
    const { problems } = inspectHeaderNames(
      Object.keys(headers),
      'upstreamHeaders',
      RESERVED_REQUEST_HEADERS,
    );
    for (const message of problems) {
      ctx.addIssue({ code: 'custom', message });
    }
  })
  .transform((headers) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
  );

const upstreamHeaders = upstreamHeaderMap.default({});

/**
 * Upstream response caching, served from the Cloudflare Cache API.
 *
 * Off unless a route says otherwise, and the defaults cover static assets only —
 * no `text/html`. That is a starting position rather than a prohibition: an
 * operator who adds a document type takes on what the README's caching section
 * spells out, and the panel flags the field. What makes even that safe is the
 * cache key, which carries a fingerprint of the whole route: two configurations
 * can never share an entry, so a rewritten body cached under one route table is
 * invisible to the next.
 *
 * Cache API rather than KV, deliberately. A KV read per request is the cost this
 * library's config cache exists to avoid (see `cache.ts`), and paying it back for
 * response caching would spend the savings twice over. The Cache API is billed
 * as part of the request instead.
 *
 * The trade-off worth stating: a body this proxy rewrote has no `ETag` or
 * `Last-Modified` — they are stripped, because keeping them lets a client serve
 * the *unrewritten* body from its own cache — so a cached entry cannot be
 * revalidated against the upstream. Freshness is TTL and nothing else.
 */
const cache = z.object({
  /**
   * Whether the block takes effect. Present so a tuned configuration can be
   * switched off without deleting the numbers that took work to arrive at.
   */
  enabled: z.boolean().default(true),
  /**
   * Methods eligible for caching. GET and HEAD only: nothing else is safe to
   * replay from a store, and the Cache API refuses a non-GET key outright
   * (verified in workerd: `put` throws `Cannot cache response to non-GET
   * request`). The two get separate entries, because a HEAD response has no body
   * and storing it under the GET key would hand the next GET an empty one —
   * verified: the entry came back with `content-length: 0`.
   */
  methods: z
    .array(
      z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum(['GET', 'HEAD'])),
    )
    .nonempty()
    .default(['GET', 'HEAD']),
  /**
   * How long an entry is served as fresh. Capped at 30 days: the route
   * fingerprint in the key means a long TTL cannot serve another configuration's
   * bytes, but it is still a window in which an upstream change is invisible, and
   * a value beyond a month is almost always a typo.
   */
  ttlSeconds: z.number().int().positive().max(2_592_000).default(300),
  /**
   * How long past the TTL an entry may still be served while a refresh runs in
   * the background. Zero disables it, and the visitor waits for the upstream.
   */
  staleWhileRevalidateSeconds: z.number().int().min(0).max(86_400).default(60),
  /**
   * Content types eligible for caching, matched as a prefix against the response
   * `Content-Type` — so `image/` covers every image format.
   *
   * The default list is static assets. `text/html` is absent on purpose: a
   * document is the response most likely to be personalised, and while the other
   * guards would catch the usual signals (a request carrying `Cookie`, a response
   * carrying `Set-Cookie` or `Cache-Control: private`), a page personalised
   * without any of them would be served to the next visitor.
   */
  contentTypes: z
    .array(z.string().min(1))
    .nonempty()
    .default(['text/css', 'text/javascript', 'application/javascript', 'image/', 'font/']),
});

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
  /** Headers injected into the upstream request. Alias for `requestHeaders.set`. */
  upstreamHeaders,
  /** Declarative rules applied to the request on its way to the upstream. */
  requestHeaders: requestHeaderRules.optional(),
  /** Declarative rules applied to the response on its way back to the client. */
  responseHeaders: responseHeaderRules.optional(),
  /** Upstream response caching. Omit to disable. */
  cache: cache.optional(),
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
    requestHeaders: routeBehaviour.requestHeaders,
    responseHeaders: routeBehaviour.responseHeaders,
    cache: routeBehaviour.cache,
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

/** A route straight out of the schema, still carrying the `upstreamHeaders` alias. */
type ParsedRoute = z.output<typeof route>;
/**
 * A route as the proxy consumes it.
 *
 * `upstreamHeaders` is gone: {@link foldUpstreamHeaders} has merged it into
 * `requestHeaders.set`, so exactly one field describes the outbound headers and
 * the forwarding code cannot read the wrong one.
 */
type RouteOutput = Omit<ParsedRoute, 'upstreamHeaders'>;
type DefaultsOutput = z.output<typeof defaults>;
type HeaderRules = z.output<typeof requestHeaderRules>;

/**
 * Fields folded entry by entry rather than replaced whole.
 *
 * `upstreamHeaders` is a bag of independent entries, so "fills gaps" applies at
 * the granularity the map has: a route adding one header of its own keeps the
 * table-wide ones. Replacing the whole map instead silently dropped them —
 * verified, a route stating `{'x-own': …}` alongside
 * `defaults: {upstreamHeaders: {'x-from-defaults': …}}` sent only its own, so a
 * shared auth or user-agent header vanished from exactly the routes that added
 * anything. nginx's `proxy_set_header` behaves the same way and is a well-known
 * footgun for it.
 *
 * The policy blocks — `cors`, `ip`, `rateLimit`, `bodyRewrite` — are deliberately
 * not here. Those are cohesive units, and merging halves of two of them yields a
 * policy neither the table nor the route wrote: `cors.origins` from one with
 * `cors.credentials` from the other is nobody's intent.
 */
const MERGED_PER_KEY = new Set(['upstreamHeaders']);

/**
 * Header-rule fields folded rule by rule rather than replaced whole.
 *
 * The same reasoning as {@link MERGED_PER_KEY}, one level deeper, because the
 * shape is `{ set, remove }` and a shallow merge would replace a whole `set` map
 * while keeping the other side's `remove`: a route adding one header of its own
 * would silently drop every table-wide one.
 *
 * `remove` is a union. A table-wide "strip the `Server` header the upstream
 * leaks" that any route could switch off by adding an unrelated rule of its own
 * would be a control lost to an edit that never mentioned it.
 *
 * The cost is that a route cannot opt *out* of a table-wide removal. That is the
 * deliberate direction to fail in — forgetting to strip is worse than stripping
 * twice — and the escape hatch is to move the rule off `defaults` and onto the
 * routes that want it.
 */
const MERGED_HEADER_RULES = new Set(['requestHeaders', 'responseHeaders']);

/** Folds one header-rule block into another: writes fill gaps, deletions union. */
const mergeHeaderRules = (base: HeaderRules, own: HeaderRules): HeaderRules => ({
  set: { ...base.set, ...own.set },
  remove: [...new Set([...base.remove, ...own.remove])],
});

/**
 * Folds `defaults` into each route.
 *
 * A key the route did not state takes the table-wide value; a key it did state
 * keeps its own. `defaults` therefore fills gaps and never overrides — including
 * within the maps listed in {@link MERGED_PER_KEY}, where a gap is a missing
 * entry rather than a missing field.
 */
const applyDefaults = (
  routes: readonly ParsedRoute[],
  statedKeys: readonly (readonly string[])[] | undefined,
  tableDefaults: DefaultsOutput,
): ParsedRoute[] => {
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
        continue;
      }
      if (MERGED_PER_KEY.has(key)) {
        // The route's own entries win, the table's fill the rest.
        merged[key] = { ...(value as object), ...(merged[key] as object) };
        continue;
      }
      if (MERGED_HEADER_RULES.has(key)) {
        merged[key] = mergeHeaderRules(value as HeaderRules, merged[key] as HeaderRules);
      }
    }
    return merged as ParsedRoute;
  });
};

/**
 * Merges the legacy `upstreamHeaders` alias into `requestHeaders.set` and drops
 * it, so one field describes the outbound headers by the time the proxy reads
 * them.
 *
 * `requestHeaders.set` wins a name written in both places — a choice only ever
 * reached when the two agree, since a name written in both with *different*
 * values is refused above. The same value twice is a harmless duplicate and is
 * merged rather than made an error, so a table that restated a header while
 * migrating to the new field keeps working.
 */
const foldUpstreamHeaders = ({ upstreamHeaders: alias, ...rest }: ParsedRoute): RouteOutput => {
  if (Object.keys(alias).length === 0) {
    return rest;
  }
  const rules = rest.requestHeaders;
  return {
    ...rest,
    requestHeaders: {
      set: { ...alias, ...rules?.set },
      remove: rules?.remove ?? [],
    },
  };
};

export const configSchema = z
  .preprocess(captureStatedKeys, documentSchema)
  .transform((doc) => ({
    version: doc.version,
    ...(doc.meta !== undefined ? { meta: doc.meta } : {}),
    routes: applyDefaults(doc.routes, doc[STATED_KEYS_FIELD], doc.defaults) as [
      ParsedRoute,
      ...ParsedRoute[],
    ],
  }))
  /**
   * Cross-field checks, run after `defaults` have been folded in.
   *
   * It has to be here rather than on the route schema: a contradiction can be
   * split across the two, and neither half is invalid alone. Verified —
   * `defaults: { totalTimeoutMs: 1000 }` with a route stating
   * `timeoutMs: 30_000` was accepted, and `forward` then clamped the
   * per-attempt budget to 1000ms with nothing said. The config claimed one
   * thing and the proxy did another.
   */
  .superRefine((config, ctx) => {
    config.routes.forEach((entry, index) => {
      if (entry.timeoutMs > entry.totalTimeoutMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'timeoutMs'],
          message:
            `timeoutMs (${entry.timeoutMs}) exceeds totalTimeoutMs ` +
            `(${entry.totalTimeoutMs}), so a single attempt can never use its ` +
            `full budget; lower timeoutMs or raise totalTimeoutMs`,
        });
      }

      // The alias must not contradict the field it aliases. `upstreamHeaders` is
      // folded into `requestHeaders.set` below, and a name written in both with
      // different values has no reading this document supports — which is exactly
      // the "two fields exist and each half takes effect" state the alias was
      // introduced to make impossible.
      const explicit = entry.requestHeaders?.set;
      if (explicit !== undefined) {
        for (const [name, value] of Object.entries(entry.upstreamHeaders)) {
          const written = explicit[name];
          if (written !== undefined && written !== value) {
            ctx.addIssue({
              code: 'custom',
              path: ['routes', index, 'upstreamHeaders', name],
              message:
                `"${name}" is written by both upstreamHeaders ("${value}") and ` +
                `requestHeaders.set ("${written}"); upstreamHeaders is an alias for ` +
                `requestHeaders.set, so state it once`,
            });
          }
        }
      }

      // A write and a deletion of one header can arrive from opposite sides —
      // `defaults` contributing the removal and the route the write, or the alias
      // contributing the write — and neither half is invalid on its own.
      const directions = [
        ['requestHeaders', entry.requestHeaders, entry.upstreamHeaders],
        ['responseHeaders', entry.responseHeaders, undefined],
      ] as const;
      for (const [field, rules, alias] of directions) {
        if (rules === undefined) {
          continue;
        }
        const written = new Set([...Object.keys(rules.set), ...Object.keys(alias ?? {})]);
        for (const name of rules.remove) {
          if (written.has(name)) {
            ctx.addIssue({
              code: 'custom',
              path: ['routes', index, field, 'remove'],
              message:
                `${field} both writes and deletes "${name}" once defaults are ` +
                `applied; state one or the other`,
            });
          }
        }
      }

      // A cache block on a route that admits none of the cacheable methods can
      // never do anything. Saying so beats leaving an operator to wonder why the
      // hit rate is zero.
      if (entry.cache !== undefined && entry.match.methods !== undefined) {
        const admitted = entry.match.methods;
        if (!entry.cache.methods.some((method) => admitted.includes(method))) {
          ctx.addIssue({
            code: 'custom',
            path: ['routes', index, 'cache', 'methods'],
            message:
              `cache.methods (${entry.cache.methods.join(', ')}) and match.methods ` +
              `(${admitted.join(', ')}) have nothing in common, so nothing on this ` +
              `route could ever be cached`,
          });
        }
      }
    });
  })
  /**
   * Folds the `upstreamHeaders` alias away, last, so every check above saw both
   * fields as the document wrote them.
   */
  .transform((config) => ({
    ...config,
    routes: config.routes.map(foldUpstreamHeaders) as [RouteOutput, ...RouteOutput[]],
  }));

export type Config = {
  version: typeof CONFIG_VERSION;
  /** Declared optional-undefined so a consumer may spread-conditionally under exactOptionalPropertyTypes. */
  meta?: z.output<typeof meta> | undefined;
  routes: [RouteOutput, ...RouteOutput[]];
};
export type Route = RouteOutput;
export type ConfigMeta = z.output<typeof meta>;
export type CorsConfig = z.output<typeof cors>;
export type RateLimitConfig = z.output<typeof rateLimit>;
export type BodyRewriteConfig = z.output<typeof bodyRewrite>;
export type CacheConfig = z.output<typeof cache>;
export type HeaderRulesConfig = HeaderRules;
export type RouteInput = z.input<typeof anyRoute>;
/** Input shape, minus the internal bookkeeping field preprocessing supplies. */
export type ConfigInput = Omit<z.input<typeof documentSchema>, typeof STATED_KEYS_FIELD>;

/** Validates and applies defaults. Throws `z.ZodError` on invalid input. */
export const defineConfig = (input: ConfigInput): Config => configSchema.parse(input) as Config;

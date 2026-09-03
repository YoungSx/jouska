import { z } from 'zod';

import { HOP_BY_HOP } from './internal/hop.js';
// Runtime import from the router for `splitUpstream`; the router imports only
// types back from here, so the cycle is type-only on that side and safe.
import { splitUpstream } from './router.js';

/**
 * Declarative route table. A route names its upstreams in exactly one of three
 * ways — a single `upstream`, an ordered `upstreams` list walked by failover, or
 * a weighted `trafficSplit` — and each request still resolves to exactly one of
 * them. Workers allows only 6 concurrent outbound connections per request, so
 * fan-out / racing upstreams is deliberately not expressible here: failover
 * attempts are strictly sequential and a split sends one request to one winner.
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

/**
 * Upper bound shared by every candidate and condition list in a route.
 *
 * One constant rather than a number per field, because the bound answers one
 * question for all of them: how much per-request work a single route may
 * declare. Each entry costs an array slot the router materialises and, for
 * candidates, at most one sequential upstream attempt.
 *
 * 64 is a ceiling on pathological configuration, not a defence. Measured with
 * `matchUrl` in workerd: 1000 routes carrying one condition each cost 20µs per
 * request in the all-miss worst case, and 6 routes carrying 16 conditions each
 * cost 2µs — both far under the 10ms CPU budget. An earlier comment justified a
 * 16-condition cap by that budget, which did not survive the measurement: the
 * expensive dimension is the route count, and that is deliberately unbounded
 * because a mirror of many sites is the point. So the honest statement is the
 * one above — this stops a config nobody meant to write, and nothing more.
 *
 * nginx bounds none of the equivalents (`proxy_next_upstream_tries` defaults to
 * `0`, meaning unlimited; an `upstream` block takes any number of `server`
 * lines; `weight` has no maximum), and where a bound here cannot name what it
 * bounds, it does not exist.
 */
const MAX_LIST = 64;

/**
 * Sequential failover across multiple upstream candidates.
 *
 * Candidates are tried strictly in order: the next one only sees the request
 * after the previous one failed with a condition listed in `on`. There is no
 * racing — Workers allows 6 concurrent outbound connections per request, and
 * racing N upstreams alongside retries would spend that budget on duplicates
 * of the same request.
 */
const failover = z.object({
  /**
   * Conditions that move the request to the next candidate. The default is the
   * network-layer pair: the attempt timed out, or the connection failed
   * outright. An HTTP 5xx is deliberately not among them — it is a normal
   * response, and replaying the request elsewhere piles the load of a
   * struggling origin onto its sibling. Adding `'5xx'` is therefore the
   * operator's explicit decision, and it only ever switches a request that
   * could still be replayed (no body, no WebSocket handshake).
   */
  on: z
    .array(z.enum(['timeout', 'unreachable', '5xx']))
    .min(1)
    .default(['timeout', 'unreachable']),
  /**
   * How many candidates may be tried. Defaults to every candidate the route
   * declares, and is clamped to the list's own length at walk time.
   *
   * Bounded by {@link MAX_LIST} because a walk cannot visit more candidates
   * than a route may declare. The operative limit on a walk is time, not count:
   * `totalTimeoutMs` ends it whatever this says. The cap used to be 6, said to
   * "mirror the platform's per-request connection cap" while admitting in the
   * same sentence that sequential attempts are not concurrent ones — a number
   * borrowed from a limit that does not apply.
   */
  maxAttempts: z.number().int().min(1).max(MAX_LIST).default(MAX_LIST),
});

/**
 * The policy a candidate route carries when it states none. Written a list of
 * upstreams means "this one first, the rest are backups" — the operator should
 * not have to spell out a failover block to get the obvious behaviour. Parsed
 * through the schema itself so this and the field defaults cannot drift apart.
 */
const DEFAULT_FAILOVER: z.output<typeof failover> = failover.parse({});

/**
 * Passive outlier ejection across multiple upstream candidates.
 *
 * Failure is remembered between requests, so the walk does not start from a
 * candidate the previous requests already proved dead: without this, every
 * visitor pays the primary's full `timeoutMs` before the backup is reached,
 * for as long as the primary stays down. Failures are counted per isolate —
 * the same approximation the native rate limit binding makes — and a candidate
 * that crosses the threshold is skipped for `ejectSeconds`.
 */
const outlier = z.object({
  /** Consecutive counted failures before the candidate is skipped. */
  consecutiveFailures: z.number().int().min(1).max(10).default(3),
  /** How long a skipped candidate stays out of the walk. */
  ejectSeconds: z.number().int().min(1).max(300).default(30),
});

const DEFAULT_OUTLIER: z.output<typeof outlier> = outlier.parse({});

/**
 * Isolate-level fuses over how much load one route may add.
 *
 * `retries` and `totalTimeoutMs` are per-request numbers: they bound what one
 * request may do, not what a thousand of them do together. On a route taking a
 * thousand concurrent requests, `retries: 2` is up to three thousand attempts
 * against an upstream that is already struggling — the classic way a proxy
 * turns a slow origin into a dead one. These two fields are the cross-request
 * half: a ceiling on the retries the route performs as a whole, and a ceiling
 * on how much of the origin's attention one route may hold at once.
 *
 * Both are counted per isolate, like `outlier` — a fuse, not a quota. Nothing
 * here coordinates across isolates, and the docs on each field say what that
 * means for sizing, because an operator who reads them as global limits will
 * compute capacity wrong in exactly the dangerous direction.
 */
const limits = z.object({
  /**
   * The share of recent requests this route may spend on retries.
   *
   * Retries are load. When the retries actually performed exceed this share of
   * the requests seen over the last couple of seconds, further walks are denied
   * their extra attempts — the first attempt still runs, so no request is
   * refused, and the walk ends at its real failure instead of amplifying it.
   * This is Envoy's `retry_budget` in the same shape: a 0.2 budget on a healthy
   * route changes nothing, and on a failing one it stops the route from
   * tripling the pressure the origin is already under.
   *
   * The window is a pair of one-second counting buckets, not a per-request
   * timestamp list — the memory is four numbers whatever the traffic, where a
   * sliding window would allocate per request and scan on every verdict.
   * Counted per isolate: it bounds one instance's contribution, not the fleet's.
   *
   * The verdict is read before a retry is performed, so a `0` ratio still lets
   * one retry through per window and refuses the next; the imprecision runs
   * toward more retries, never fewer. Omit the field to leave `retries`
   * unbounded.
   */
  retryRatio: z.number().min(0).max(1).optional(),
  /**
   * Concurrent requests this route may hold against one upstream, per isolate.
   *
   * When the count is reached, a further request is answered with 503 at once
   * rather than queued or forwarded. Traefik's `InFlightReq` with `limit`
   * capacity and no queue: the fuse exists to keep a struggling upstream from
   * being pushed over, and queueing would only move the pile-up from the origin
   * to the proxy, where the requests still cost the origin the moment a seat
   * frees.
   *
   * **Per isolate, deliberately — say it that way in runbooks.** A hundred
   * isolates each admitting 100 can put ten thousand requests on the origin.
   * Size the number as a single-instance backstop against one isolate's own
   * runaway, never as the origin's global connection budget; nothing here
   * coordinates across isolates, and Cloudflare does not promise how many
   * isolates a route's traffic lands on.
   *
   * A seat is held from the check until response headers come back — not for
   * the body, so a stream that runs for minutes does not hold its seat while it
   * streams. The check runs after the response cache: a hit never touches the
   * upstream, so it never takes a seat, and a saturated origin cannot turn a
   * cache hit into a 503.
   *
   * The ceiling exists to catch a mistyped unit (`1e9`), not to name a platform
   * limit: the useful values are three digits at most.
   */
  maxInFlight: z.number().int().min(1).max(10_000).optional(),
});

/** One weighted candidate of a `trafficSplit`. */
const trafficSplitEntry = z.object({
  upstream,
  /**
   * Relative weight, not a percentage: 95/5 and 19/1 are the same split, and
   * demanding a sum of 100 makes a three-way split like 50/30/20 arithmetic
   * the operator should not have to do.
   *
   * The ceiling is what keeps the sum of every weight inside the safe integer
   * range that `selectUpstream` adds them up in — `MAX_LIST` candidates at a
   * million apiece is six orders of magnitude clear of it. nginx leaves `weight`
   * unbounded; this bound names the arithmetic it protects.
   */
  weight: z.number().int().min(1).max(1_000_000),
});

/**
 * Weighted traffic split across upstreams, for canary and version-migration
 * routes. The winner is decided before the request is forwarded, so every
 * downstream step — URL resolution, body rewriting, event reporting — sees the
 * candidate that was actually hit.
 *
 * Bounded by {@link MAX_LIST}. It used to be 6, "like `upstreams`, for the same
 * legibility of a route's worst case" — a reason copied from a field it does not
 * fit: a split picks exactly one candidate and never walks, so it has no
 * multi-attempt worst case to keep legible. A migration across eight versions
 * was refused by the schema for no reason anyone could state.
 */
const trafficSplit = z.array(trafficSplitEntry).min(1).max(MAX_LIST);

/** How a split request remembers which upstream it was assigned to. */
const stickyBy = z.enum(['cookie']);

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
 * What a split's weighted hash is taken over.
 *
 * The default is the caller's address, which is what the split has always
 * hashed on. The content keys exist for the case that is not the question being
 * asked: `path` and `url` pin a resource rather than a caller, so each upstream
 * can hold its own cache of the same URL instead of every upstream caching
 * everything, and the object forms branch on a header, cookie or query value —
 * a tenant id that has no relationship to which address the caller sits behind.
 *
 * A content key that turns up absent on the request falls back to the address
 * rather than to a constant: a constant would pile every such caller into one
 * bucket, the exact flaw the addressless case already has. The fallback is
 * reported in `Selection.scope` as `'ip'` — what was actually hashed, not what
 * was configured — so a distribution skewing that way points at callers missing
 * the key.
 *
 * Deliberately *not* a free-form variable expression like nginx's `hash $key`:
 * every spelling here is a fixed field read, so the schema can name the key in
 * a reviewable way and `Selection.scope` can report which one ran.
 */
const hashBy = z.discriminatedUnion('source', [
  z.object({ source: z.literal('ip') }),
  z.object({ source: z.literal('path') }),
  z.object({ source: z.literal('url') }),
  z.object({
    source: z.literal('header'),
    /** The header to read. Case-insensitive to `Headers.get` already. */
    header: headerName,
  }),
  z.object({
    source: z.literal('cookie'),
    cookie: z
      .string()
      .min(1)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'expected a valid cookie name (RFC 6265 token)'),
  }),
  z.object({
    source: z.literal('query'),
    query: z
      .string()
      .min(1)
      .refine(
        (name) => !/[\s&=#]/.test(name),
        'expected a query parameter name without whitespace, "&", "=" or "#" — those characters cannot survive in a name',
      ),
  }),
]);

/**
 * How the hashed key is mapped onto the split's candidates.
 *
 * `modulo` is the original behaviour: the key's hash is taken modulo the sum of
 * the weights, and the result walked down the weight space. Deterministic and
 * proportional, but its bucket boundaries are functions of *all* the weights, so
 * changing any one of them re-assigns every caller without a sticky cookie —
 * adjusting a 95/5 canary to 9/1 re-shuffles the entire audience.
 *
 * `consistent` places each candidate on a virtual-node ring. Changing a weight
 * (or removing a candidate) moves only the keys that land in the arc that
 * candidate owned, and everything else keeps its assignment — the property a
 * rolling canary adjustment needs. Costs a ring built once per configuration
 * instead of one modulo.
 */
const hashType = z.enum(['modulo', 'consistent']);

/**
 * Value operators for a `match` condition, shared by all three families.
 *
 * Deliberately three and not more. There is no regex: the route table is edited
 * from a panel and stored in D1, so a catastrophic-backtracking pattern would be
 * a CPU bomb any editor can plant, on a runtime that bills 10 ms of CPU per
 * request. `equals` and `prefix` cover what canaries actually branch on; anything
 * beyond that is a design conversation, not a schema field.
 *
 * Exactly one operator per condition. An empty `prefix` is refused — it reads as
 * `present: true` spelled a second way, and two spellings of one meaning is how
 * configs start disagreeing with themselves. An empty `equals` is allowed: it
 * matches the empty value an `X-Foo:` header or a `?debug=` parameter carries,
 * which is a real value, not the absence of one.
 */
const conditionOperators = {
  /** Exact match against the value, compared case-sensitively. */
  equals: z.string().optional(),
  /** Value starts with this string, compared case-sensitively. */
  prefix: z.string().min(1).optional(),
  /**
   * Presence of the name, independent of its value. `true` matches an empty
   * value too — `X-Foo:` is a header that exists — so `present: false` means
   * "the name is not there at all" and is not fooled by an empty one.
   */
  present: z.boolean().optional(),
};

const requireOneOperator = (condition: { equals?: string; prefix?: string; present?: boolean }) =>
  Number(condition.equals !== undefined) +
    Number(condition.prefix !== undefined) +
    Number(condition.present !== undefined) ===
  1;

/**
 * One `match` condition on a request header.
 *
 * The name is an RFC 9110 token, lowercased here so the matcher compares
 * exactly — header names are case-insensitive, and normalising at parse time is
 * the same law `blockCountries` already lives under. Values are *not* folded:
 * `X-Env: Prod` and `X-Env: prod` are two values, and silently treating them as
 * equal is more dangerous than treating them as different.
 *
 * This routes, it does not authenticate. `match.headers` selects a route; it
 * never validates one, because any caller can send `X-Internal: 1` themselves.
 */
const headerCondition = z
  .object({ name: headerName, ...conditionOperators })
  .superRefine((condition, ctx) => {
    if (!requireOneOperator(condition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'state exactly one of equals, prefix or present',
      });
    }
  })
  .transform((condition) => ({ ...condition, name: condition.name.toLowerCase() }));

/** One `match` condition on a query parameter. Names are case-sensitive. */
const queryCondition = z
  .object({
    name: z
      .string()
      .min(1)
      .refine(
        (name) => !/[\s&=#]/.test(name),
        'expected a query parameter name without whitespace, "&", "=" or "#" — those characters cannot survive in a name',
      ),
    ...conditionOperators,
  })
  .superRefine((condition, ctx) => {
    if (!requireOneOperator(condition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'state exactly one of equals, prefix or present',
      });
    }
  });

/** One `match` condition on a request cookie. Names are case-sensitive (RFC 6265 token). */
const cookieCondition = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'expected a valid cookie name (RFC 6265 token)'),
    ...conditionOperators,
  })
  .superRefine((condition, ctx) => {
    if (!requireOneOperator(condition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'state exactly one of equals, prefix or present',
      });
    }
  });

/**
 * Bound on conditions per family; see {@link MAX_LIST} for what the number
 * bounds and what it deliberately does not claim to defend against.
 */
const MAX_MATCH_CONDITIONS = MAX_LIST;

/** The four anchors `bodyRewrite.inject` can name, in reporting order. */
const ANCHOR_KEYS = ['headStart', 'headEnd', 'bodyStart', 'bodyEnd'] as const;

/**
 * The budget all four `inject` anchors share: 64 KiB of UTF-8, the ceiling the
 * admin panel already applies to a whole route definition (`MAX_DEFINITION_BYTES`
 * in the panel's validate.ts). A route could not carry more than this anyway —
 * the panel would refuse the document — so the schema states the bound the
 * deployment actually enforces rather than a second, unrelated one.
 */
const MAX_INJECT_BYTES = 64 * 1024;

const match = z
  .object({
    /** Matches the request host. `*.example.com` matches subdomains, not the apex. */
    host: hostnameOrWildcard.optional(),
    /** Path prefix, e.g. `/openai`. Matched on segment boundaries. */
    path: z.string().startsWith('/').optional(),
    methods: methods.optional(),
    /** Header conditions, all of which must hold. See {@link headerCondition}. */
    headers: z.array(headerCondition).max(MAX_MATCH_CONDITIONS).optional(),
    /** Query parameter conditions, all of which must hold. See {@link queryCondition}. */
    query: z.array(queryCondition).max(MAX_MATCH_CONDITIONS).optional(),
    /** Cookie conditions, all of which must hold. See {@link cookieCondition}. */
    cookies: z.array(cookieCondition).max(MAX_MATCH_CONDITIONS).optional(),
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
  /**
   * Markup inserted into HTML documents at fixed anchors of the structure:
   * `headStart`/`headEnd` just inside `<head>`'s opening and just before its
   * closing tag, `bodyStart`/`bodyEnd` likewise for `<body>`.
   *
   * Only responses that go through the HTML rewriter are touched — the
   * `contentTypes` list still decides which those are. The markup is inserted
   * verbatim and is deliberately *not* passed back through link rewriting: it
   * was written by the operator, pointing where they meant it to point, and a
   * second pass over it would be the runtime deciding otherwise.
   *
   * This is the XSS surface of body rewriting: whoever can edit a route can run
   * script in every visitor's page. The panel flags it accordingly, which is the
   * same posture as `upstreamHeaders` — permitted, but never quiet about it.
   *
   * Each anchor is a DOM position rather than a string match, so `</HEAD>`,
   * minified output or a missing closing tag cannot defeat it the way a literal
   * `replace` against `</head>` can — though a `headEnd`/`bodyEnd` anchor does
   * need that closing tag to exist at all, and reports when it did not.
   */
  inject: z
    .object({
      /** Markup inserted just inside the opening `<head>`. */
      headStart: z.string().min(1).optional(),
      /** Markup inserted just before `</head>`. */
      headEnd: z.string().min(1).optional(),
      /** Markup inserted just inside the opening `<body>`. */
      bodyStart: z.string().min(1).optional(),
      /** Markup inserted just before `</body>`. */
      bodyEnd: z.string().min(1).optional(),
    })
    .superRefine((inject, ctx) => {
      // An empty block turns the rewriter on for nothing: the HTML path runs, the
      // event reports a body that was rewritten, and no page changes. Refused
      // rather than accepted as a switch with no effect.
      if (ANCHOR_KEYS.every((key) => inject[key] === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [],
          message: 'inject must set at least one anchor',
        });
        return;
      }
      // Four fields sharing one budget, so the bound lives on the sum and not on
      // each field: four fields a quarter of the budget each would let a config
      // quadruple it, and four separate numbers would be a limit on nothing.
      //
      // 64 KiB is the route document's own ceiling (MAX_DEFINITION_BYTES in the
      // panel's validate.ts) rather than a second, invented number. A banner
      // large enough to matter is a page someone maintains, and it lives in the
      // same document that carries the rest of the route.
      const bytes = ANCHOR_KEYS.reduce(
        (total, key) => total + new TextEncoder().encode(inject[key] ?? '').length,
        0,
      );
      if (bytes > MAX_INJECT_BYTES) {
        ctx.addIssue({
          code: 'custom',
          path: [],
          message: `inject totals ${bytes} bytes across its anchors; the shared budget is ${MAX_INJECT_BYTES}`,
        });
      }
    })
    .optional(),
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
 * Hotlink protection: an allow-list of sites whose links are honoured.
 *
 * The entries reuse the hostname schema, so a pattern may be `*.`-prefixed to
 * cover every subdomain at once. An absent or non-HTTP(S) `Referer` is the
 * "empty" case governed by `allowEmpty` — typed URLs, bookmarks and privacy
 * strips all arrive without one, so the default admits them; the guard exists
 * to stop another site embedding assets, not to wall off direct navigation.
 */
const referer = z.object({
  /** Hostnames admitted, each optionally `*.`-prefixed to match subdomains. */
  allow: z.array(hostnameOrWildcard).nonempty(),
  /** Whether a request with no usable Referer is admitted. */
  allowEmpty: z.boolean().default(true),
  /** Status returned to a refused request; 404 hides that a guard fired. */
  onRefuse: z.union([z.literal(403), z.literal(404)]).default(403),
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
 * A single query-parameter name. URL syntax is the constraint: `&`, `=` and `#`
 * end a name, and whitespace makes one unparsable, so any of them in a
 * configured name would produce a signature no issuer could ever emit.
 */
const queryParamName = z
  .string()
  .min(1)
  .refine(
    (name) => !/[\s&=#]/.test(name),
    'expected a query parameter name without whitespace, "&", "=" or "#" — those characters cannot survive in a name',
  );

/**
 * Signed links: requests must carry a valid HMAC over the path and expiry, so
 * the URL itself is the credential and cannot be circulated beyond its `exp`.
 *
 * The signature is computed over bytes the issuer and this verifier both see
 * verbatim — the request path and the raw expiry digits — rather than anything
 * re-serialised, so a URL produced by one survives the other's parsing.
 */
const signedLink = z.object({
  /** Name of the secret binding; resolved from the environment per request. */
  secretBinding: z.string().min(1),
  /** Query parameter holding the base64url signature. */
  param: queryParamName.default('sig'),
  /** Query parameter holding the Unix-expiry seconds. */
  expiresParam: queryParamName.default('exp'),
});

/**
 * The largest body `maxBodyBytes` may name: 500 MiB, the platform's largest
 * documented request-body ceiling (Enterprise). A larger value could never take
 * effect in full — the platform refuses the body first — so config that promises
 * one is refused rather than accepted as a limit that sometimes applies.
 */
const MAX_REQUEST_BODY_BYTES = 524_288_000;

/**
 * What a matched route accepts before forwarding: which methods, and how large
 * a request body.
 *
 * Distinct from `match.methods` by design — that decides whether the route is
 * matched at all (a miss is handed back to the app with `next()`), this decides
 * whether a matched request is refused (with 405 and an `Allow` header). The
 * distinction is load-bearing: a route matching only GET cannot be told to
 * refuse POST, because POST never reaches it.
 */
const requestPolicy = z.object({
  /** Methods this route forwards. A matched request outside the set gets 405. */
  allowedMethods: methods.optional(),
  /**
   * Largest accepted request body, enforced twice: a request declaring a larger
   * `Content-Length` is refused before anything is forwarded, and one without
   * that header — a chunked upload declares none — is counted while streaming
   * and cut off mid-flight once it passes the ceiling. The second enforcement
   * cannot unsend what the upstream already received, so a fast-responding
   * upstream may see part of the body; the bytes that reach it are bounded by
   * this number either way.
   */
  maxBodyBytes: z.number().int().positive().max(MAX_REQUEST_BODY_BYTES).optional(),
});

/**
 * Per-route access control: who is allowed, answered by cryptographic proof
 * rather than by where the request came from.
 *
 * The platform-first recommendation lives in the README: Cloudflare Access on
 * the Worker's hostname authenticates *before* this code runs, and a route
 * cannot beat that. This block exists for the hostname that cannot take a
 * zone-wide Access application — one proxy serving both public and internal
 * routes.
 *
 * Two mechanisms, usable alone or together. A request must satisfy every one
 * that is configured.
 *
 * Keys are stored as SHA-256 digests, so the key itself never enters the
 * document the panel displays and KV persists — the same shape as the panel's
 * own `mcp_tokens.token_hash`. No salt, deliberately: a key worth protecting is
 * a high-entropy random value, so a rainbow table has nothing to chew on, and a
 * salt would have to live beside the digest in the same readable document
 * anyway.
 */
const access = z
  .object({
    /**
     * Verify a Cloudflare Access JWT. `team` is the subdomain of
     * `cloudflareaccess.com`; the JWKS URL is built from it and can never point
     * anywhere else. `audience` is the Access application's AUD tag and is
     * required: a token signed by the right team for the wrong application is
     * refused, not merely unverified.
     */
    cloudflare: z
      .object({
        team: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, 'expected a Cloudflare Access team name'),
        audience: z.string().min(1),
        /** When set, an authenticated identity outside this list is refused. */
        emails: z.array(z.string().email()).nonempty().optional(),
      })
      .optional(),
    /** SHA-256 digests (hex) of accepted API keys. */
    keys: z
      .array(z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-character hex SHA-256 digest'))
      .nonempty()
      .optional(),
    /**
     * Where the API key arrives. Defaults to `authorization`, read past a
     * `Bearer ` prefix; a custom header's raw value is the key. Validated as an
     * RFC 9110 token so a bad name fails at config load rather than at the
     * first request that needed it. Inline rather than the shared `headerName`:
     * that schema is declared further down, and hoisting it would reorder a
     * file whose reading order is deliberate.
     */
    header: z
      .string()
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'expected a valid HTTP header name (RFC 9110 token)')
      .optional(),
  })
  .refine((a) => a.cloudflare !== undefined || a.keys !== undefined, {
    message: 'access needs at least one of cloudflare or keys — an empty block guards nothing',
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
 * Request headers a route may neither write nor delete.
 *
 * Three groups, refused for three different reasons:
 *
 *  - **Forwarding identity.** `host` and the `x-forwarded-*` trio are derived
 *    from the request. They used to be silently overwritten by jouska's own
 *    values afterwards — correct, but only because of where the spread happened
 *    — and a config that cannot take effect should say so rather than appear to
 *    work. `x-request-id` is in the same position: the proxy stamps the value it
 *    resolved (see `requestId`) onto every upstream attempt, so a written one
 *    would be discarded per candidate while reading as live.
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
  'x-request-id',
  // The mirror marker: the proxy stamps it onto every background copy it sends,
  // so an upstream can tell the duplicate from the real request. Reserved for
  // the same reason the forwarding headers are — a route that could write it
  // could disguise a real request as a copy, and whatever an operator's
  // analysis excludes because "it is only the mirror" would be lying.
  'x-jouska-mirror',
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
 * Query parameters reach the key in exactly one of three shapes.
 *
 * `"all"` keeps everything — today's behaviour, and the default. `"none"`
 * drops the search string entirely. The object form names parameters: `ignore`
 * drops the named noise, `include` keeps only the named signal. The two must
 * not co-occur (`{ ignore: ['a'], include: ['b'] }` says both "forget `a`" and
 * "forget everything but `b`", whose combined meaning nobody should have to
 * guess) and an empty object is refused, because `{} = all = none` reads three
 * ways and a reader would have to trust the runtime to pick one.
 *
 * Parameter names are compared case-sensitively: the query is opaque bytes to
 * HTTP, and an upstream is free to treat `Tab` and `tab` differently — merging
 * them here would map two upstream-distinct requests onto one entry.
 */
const cacheKeyQuery = z.union([
  z.literal('all'),
  z.literal('none'),
  z
    .object({
      ignore: z.array(z.string().min(1)).nonempty().optional(),
      include: z.array(z.string().min(1)).nonempty().optional(),
    })
    .superRefine((value, ctx) => {
      if (value.ignore !== undefined && value.include !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['include'],
          message: 'cache.key.query states one selection: name ignore or include, not both',
        });
      }
      if (value.ignore === undefined && value.include === undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            'cache.key.query must name parameters — "all" and "none" are the spellings for keeping or dropping everything',
        });
      }
    }),
]);

/**
 * Request header names folded into the cache key.
 *
 * A header here makes the key distinguish requests by that header's value —
 * which is both a hit-rate decision (fold a high-cardinality header and the
 * cache becomes one entry per visitor) and a safety decision, because folding
 * a header is what lets a matching `Vary` be honoured instead of refusing the
 * response outright.
 *
 * `cookie` and `authorization` are refused rather than accepted-and-ignored:
 * requests carrying either are never cached at all (see "What is never
 * cached"), so folding them into the key changes nothing, and a configuration
 * that names them is promising an effect it cannot have.
 */
const cacheKeyHeaders = z
  .array(headerName)
  .superRefine((names, ctx) => {
    for (const name of names) {
      if (['authorization', 'cookie'].includes(name.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          message:
            `cache.key.headers may not name "${name}": a request carrying it is never ` +
            `cached, so folding it into the key changes nothing — see the README's ` +
            `"What is never cached"`,
        });
      }
    }
  })
  // Lowercased and deduplicated so the runtime compares one spelling against
  // the response's `Vary`, and a repeated name cannot double-count.
  .transform((names) => [...new Set(names.map((name) => name.toLowerCase()))])
  .default([]);

/**
 * What an entry's identity is built from, beyond the path. See the `key`
 * field on the `cache` block.
 */
const cacheKey = z.object({
  query: cacheKeyQuery.default('all'),
  headers: cacheKeyHeaders,
});

/**
 * A full URL for jouska to fetch directly — the delegated-auth endpoint.
 *
 * Unlike `upstream` this carries its own scheme, because the endpoint is not a
 * routing target: it is a fixed service address, and `forwardAuth` has no
 * `scheme` field to hold one. The host passes the same refusal as `upstream` —
 * an auth endpoint that is a loopback or metadata address is a request-forgery
 * surface exactly like a proxy that will fetch any host an operator types, and
 * it is runtime-editable through KV just the same.
 */
const authUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
    message: 'expected an absolute http:// or https:// URL',
  })
  .transform((v) => {
    // Canonicalise through the parser: a hand-written comparison against the
    // string would let trailing slashes, ports and casing drift between a
    // stored config and the URL the runtime actually fetches.
    const parsed = new URL(v);
    parsed.hash = '';
    return parsed.toString();
  })
  .superRefine((v, ctx) => {
    const host = new URL(v).hostname;
    if (isForbiddenHost(host)) {
      ctx.addIssue({
        code: 'custom',
        message:
          `forwardAuth url "${host}" resolves to a loopback, private or ` +
          'metadata address; set allowPrivateUpstream on the route to permit it',
      });
    }
  });

/**
 * The private-address-exempt twin of {@link authUrl}, for routes that opted in
 * via `allowPrivateUpstream`. Same reasoning as {@link upstreamAllowingPrivate}:
 * Zod cannot consult a sibling field from inside a refinement, so the permissive
 * variant lives in its own branch rather than behind a flag.
 */
const authUrlAllowingPrivate = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
    message: 'expected an absolute http:// or https:// URL',
  })
  .transform((v) => {
    const parsed = new URL(v);
    parsed.hash = '';
    return parsed.toString();
  });

/**
 * Header names a route may copy into or out of the delegated-auth exchange.
 *
 * `copyResponseHeaders` writes into the *upstream request*, so it is refused on
 * the same list as `requestHeaders.set` — reusing {@link RESERVED_REQUEST_HEADERS}
 * here is the point: a separate, shorter list would be a way around the
 * `host`/`x-forwarded-*` refusals by another door. `copyRequestHeaders` is
 * checked against the same set (the runtime would overwrite anything in it
 * anyway), while leaving `authorization`/`cookie` — the reason the field exists
 * — untouched.
 */
const authHeaderNames = (field: string) =>
  z.array(headerName).superRefine((names, ctx) => {
    const { canonical, problems } = inspectHeaderNames(names, field, RESERVED_REQUEST_HEADERS);
    for (const message of problems) {
      ctx.addIssue({ code: 'custom', message });
    }
    void canonical;
  });

/**
 * Delegated authentication in the nginx `auth_request` shape: ask one endpoint
 * whether the caller is who they claim to be, before anything reaches the
 * upstream.
 *
 * The request body is never sent to the endpoint — it is a one-shot stream the
 * proxy still needs for the upstream, and an auth service reads headers, not
 * bodies. On a non-2xx the auth response itself is relayed verbatim, so a login
 * redirect or `WWW-Authenticate` challenge arrives as the service wrote it.
 *
 * Failure to *reach* the endpoint is refused rather than admitted by default:
 * the endpoint being down is not evidence that the caller is legitimate.
 * `failOpen` exists for the deployments that would rather stay up, and is
 * flagged dangerous in the panel for the same reason `allowPrivateUpstream` is.
 */
const forwardAuthSchema = z.object({
  /**
   * Absolute URL of the auth endpoint. Fetched directly, never via the route
   * table. Required: an auth block without an address would silently admit
   * everything while looking like it protects something.
   */
  url: authUrl,
  /**
   * Client headers relayed to the auth endpoint. Defaults to the credential
   * pair, since that is what every auth service reads; an empty list is the
   * spelling for an endpoint that needs nothing.
   */
  copyRequestHeaders: authHeaderNames('forwardAuth.copyRequestHeaders')
    .nonempty()
    .default(['authorization', 'cookie']),
  /**
   * Auth-response headers written into the upstream request — how the caller's
   * identity reaches the upstream (`x-user-id` is the usual case).
   */
  copyResponseHeaders: authHeaderNames('forwardAuth.copyResponseHeaders').nonempty().default([]),
  /** Deadline for the auth exchange, shorter than any upstream attempt default. */
  timeoutMs: z.number().int().positive().max(5_000).default(2_000),
  /**
   * Serve the upstream even when the auth endpoint cannot be reached. Absent
   * means fail closed — the default exists so that an auth outage is an outage,
   * not an open door. A `z.literal(true)` rather than a boolean so that
   * `failOpen: false` is not accepted as a way of *writing down* the default;
   * the absence of the field is the statement.
   */
  failOpen: z.literal(true).optional(),
});

/**
 * The auth policy block, with a permissive-url variant of `forwardAuth` for
 * private routes. Written as a function of the URL schema so the two branches
 * cannot drift — a check added to one and forgotten in the other would make
 * `allowPrivateUpstream` a way around the SSRF refusal.
 */
const authBlocks = (url: typeof authUrl) =>
  ({
    forwardAuth: forwardAuthSchema.extend({ url }).optional(),
  }) as const;

const authBehaviour = authBlocks(authUrl);
const authBehaviourPrivate = authBlocks(authUrlAllowingPrivate);

/**
 * Traffic mirroring: a background copy of a matched request sent to a second
 * upstream whose response is discarded.
 *
 * A split moves risk onto visitors — five percent of them really do run on v2. A
 * mirror moves none: the visitor's request goes to the route's upstream as
 * always, and v2 sees a duplicate it cannot influence. That difference decides
 * every default here. `methods` names only the idempotent ones, because a
 * mirrored POST executes twice and the double is the failure (two emails, two
 * charges); widening it is a statement the panel flags as high-danger.
 * `includeBody` is off because copying a body means buffering it in memory
 * against a 128MB isolate, and the cap that bounds that buffering abandons the
 * copy, never the request.
 *
 * `percent` is a sample, not a toggle, and it is hashed rather than drawn: the
 * same deterministic hash a traffic split uses, so "was this request mirrored"
 * is recomputable from the request itself. A `Math.random()` draw answers no
 * such question after the fact.
 *
 * `timeoutMs` is this block's own short deadline rather than the route's
 * `timeoutMs`, which the visitor is waiting on and a mirror has nobody waiting
 * for it at all — a slow mirror target must burn `waitUntil` budget, not
 * response time.
 */
const mirrorShape = (target: typeof upstream) =>
  z.object({
    /** Where the copy goes, validated by the same per-value SSRF screen. */
    upstream: target,
    /** Percentage of matching requests mirrored, hashed per request. */
    percent: z.number().int().min(1).max(100).default(100),
    /**
     * Copy the request body too. The copy is buffered in memory up to
     * `MIRROR_BODY_MAX_BYTES`; beyond it the mirror is abandoned and the
     * request carries on untouched.
     */
    includeBody: z.boolean().default(false),
    /**
     * Methods eligible for mirroring, uppercased like every method list.
     * Defaults to the idempotent set: mirroring anything else runs it twice.
     */
    methods: methods.default(['GET', 'HEAD']),
    /** Own deadline for the copy, shorter than any upstream attempt default. */
    timeoutMs: z.number().int().positive().max(5_000).default(2_000),
  });

/**
 * Written as a function of the upstream schema for the same reason
 * {@link authBlocks} is: the private variant must inherit every check the strict
 * one gains, and a restated object is a way for the two to drift until
 * `allowPrivateUpstream` becomes a way around the SSRF refusal.
 */
const mirror = mirrorShape(upstream);
const mirrorAllowingPrivate = mirrorShape(upstreamAllowingPrivate);

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
/**
 * Upper bound on every cache lifetime: TTL, the stale-while-revalidate window,
 * the stale-if-error window and the per-status TTLs.
 *
 * One year, because that is the lifetime the immutable-asset convention already
 * uses (`Cache-Control: max-age=31536000`), and a proxy that caches such an
 * asset should be able to say so. The previous bounds — 30 days for a TTL, a day
 * for either stale window — rested on "a value beyond a month is almost always a
 * typo", which is a guess about the operator rather than a fact about the
 * system. What is a fact: the route fingerprint is part of the cache key, so no
 * lifetime however long can serve bytes produced by a different configuration.
 *
 * nginx bounds none of the equivalents (`proxy_cache_valid` takes any time,
 * `proxy_cache_use_stale` bounds staleness not at all).
 */
const MAX_CACHE_SECONDS = 31_536_000;

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
   * How long an entry is served as fresh. Bounded by {@link MAX_CACHE_SECONDS}.
   *
   * A long TTL is a window in which an upstream change is invisible, which is
   * the operator's trade to make: the route fingerprint in the key already
   * guarantees it cannot be a window in which *another configuration's* bytes
   * are served.
   */
  ttlSeconds: z.number().int().positive().max(MAX_CACHE_SECONDS).default(300),
  /**
   * How long past the TTL an entry may still be served while a refresh runs in
   * the background. Zero disables it, and the visitor waits for the upstream.
   */
  staleWhileRevalidateSeconds: z.number().int().min(0).max(MAX_CACHE_SECONDS).default(60),
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
  /**
   * Serve a stored entry that has already expired when the upstream cannot
   * answer. Absent means off: the expired entry is dropped and the failure is
   * returned as today.
   *
   * `on` states which upstream failures count as an error. The default is the
   * narrow reading — the upstream *never answered* (`timeout`, `unreachable`).
   * An upstream that answered with a 5xx said something, and `5xx` is an opt-in
   * exactly because a maintenance page served stale is a choice, not a default.
   * A client that hung up (`client_closed`) never triggers it: nobody is left
   * to serve.
   *
   * The window shares the stored lifetime with the stale-while-revalidate one —
   * both are measured from the TTL, and the stored copy carries whichever is
   * longer, so an entry is not evicted by the platform before this window ends.
   */
  staleIfError: z
    .object({
      seconds: z.number().int().min(0).max(MAX_CACHE_SECONDS).default(3600),
      on: z
        .array(z.enum(['timeout', 'unreachable', '5xx']))
        .min(1)
        .default(['timeout', 'unreachable']),
    })
    .optional(),
  /**
   * Collapse a burst of cold misses onto one upstream request.
   *
   * The first caller after a miss fetches and fills the cache; the rest wait for
   * the fill and are served from the entry. The wait is bounded by the route's
   * `totalTimeoutMs` — a waiter that gives up fetches on its own, degrading to
   * exactly today's behaviour. The lock is per isolate, not a distributed lock;
   * across isolates a burst collapses per isolate, which is still a large factor.
   */
  lockMisses: z.boolean().default(true),
  /**
   * Lifetimes for statuses other than 200, keyed by status code.
   *
   * A status is cached only when it has a window here; 200 keeps `ttlSeconds`
   * and an entry for `200` overrides it (`0` opts 200 out). That makes "the key
   * is absent" and "the value is 0" different facts — absent falls back, zero
   * refuses — which the negative-caching knobs otherwise collapse.
   *
   * Values share `ttlSeconds`' bound ({@link MAX_CACHE_SECONDS}). Some statuses are
   * refused outright, each for a verified or structural reason: 1xx are not
   * storable responses; 204 and 304 have no replayable body (304's validators
   * are stripped by this proxy, so the entry could not even be answered with);
   * 206 is rejected by the Cache API outright; and 5xx are accepted by `put`
   * and then silently absent from `match` in workerd — an entry that never
   * serves is a hit rate the header would lie about.
   */
  statusTtlSeconds: z
    .record(z.string().regex(/^[1-5]\d{2}$/), z.number().int().min(0).max(MAX_CACHE_SECONDS))
    .superRefine((ttls, ctx) => {
      for (const status of Object.keys(ttls)) {
        const code = Number(status);
        if (code < 200) {
          ctx.addIssue({
            code: 'custom',
            message: `statusTtlSeconds: ${status} is not a storable response`,
          });
        } else if (code === 204 || code === 304) {
          ctx.addIssue({
            code: 'custom',
            message: `statusTtlSeconds: ${status} has no replayable body (and a 304's validators are stripped)`,
          });
        } else if (code === 206) {
          ctx.addIssue({
            code: 'custom',
            message: 'statusTtlSeconds: 206 is rejected by the Cache API outright',
          });
        } else if (code >= 500) {
          ctx.addIssue({
            code: 'custom',
            message: `statusTtlSeconds: ${status} is accepted by put and silently absent from match in workerd, so the entry could never be served`,
          });
        }
      }
    })
    .optional(),
  /**
   * What an entry's identity is built from, beyond the path.
   *
   * Today the key is the whole request URL, so one tracking parameter
   * (`utm_source`, `fbclid`) turns one resource into one entry per link it was
   * shared in, and a response varying on `accept-language` cannot be cached at
   * all — the key does not represent the one thing the upstream varies on.
   * `query` controls which parameters reach the key; `headers` folds request
   * header values into it. Folding a header into the key is also what makes a
   * matching `Vary` cacheable — see `varyIsCovered` — which is why the two
   * fields share this block.
   *
   * The block sits inside `cache`, so it is part of the route the fingerprint
   * hashes: changing it produces different keys and the old entries expire
   * unnoticed, the same mechanism every other route edit relies on.
   *
   * `prefault` rather than `default`: a `default` returns its value verbatim,
   * unparsed, so the inner defaults (`query: 'all'`, `headers: []`) would never
   * be applied and the key would run on `undefined`s.
   */
  key: cacheKey.prefault({}),
});

/**
 * A redirect target for {@link respond}.
 *
 * The default `301` covers the dominant "this moved for good" case; `302`,
 * `303`, `307` and `308` are the other statuses that name a redirect rather
 * than an error. A `Location` value must survive the browser too, so the set is
 * spelled out rather than left as a range — 300 and 304 are not directives a
 * route table can issue on a client's behalf.
 */
const redirectStatuses = [301, 302, 303, 307, 308] as const;

/**
 * A redirect target, with the refusals that keep it pointing at this proxy.
 *
 * `to` accepts a relative path or an absolute URL, and the two mean different
 * things a schema cannot confuse:
 *
 * A relative path — `to: '/v2/docs'` — is resolved against the request's own
 * origin at answer time, so the redirect goes wherever the request came from.
 * That is the ordinary "this endpoint moved" case, and it needs nothing extra.
 * The path must start with `/` and start with nothing else: `//evil.example`
 * is a protocol-relative URL that browsers read as another host, and `/\` is
 * read as `//` by some. Both are refused rather than escaped.
 *
 * An absolute URL is, by that spelling, another host. It is still legitimate —
 * a domain that moved wholesale points its replacement at the old one — but a
 * route table that will silently send visitors to any host named in it is a
 * misconfigured or corrupted entry away from an open redirect, so it requires
 * the explicit `allowExternal: true` switch. (Writing "the proxy's own host"
 * as an absolute URL cannot be validated here: the proxy's host is a fact of
 * the deployment, not of the route table, and a value that matches it today
 * breaks the day the proxy moves. Write the relative path instead — it means
 * the same thing and survives the move.)
 */
const respondRedirect = z
  .object({
    /** Where to send the visitor: a relative path, or an absolute URL with `allowExternal`. */
    to: z.string().min(1),
    /** Redirect status. Defaults to `301`. */
    status: z.literal(redirectStatuses).default(301),
    /**
     * Permit an absolute URL naming another host. Off by default — see the
     * object's own comment for why this is opt-in rather than free.
     */
    allowExternal: z.literal(true).optional(),
  })
  .superRefine((redirect, ctx) => {
    const to = redirect.to;
    if (to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\')) {
      return;
    }
    if (to.startsWith('//') || to.startsWith('/\\')) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message:
          `respond.redirect.to "${to}" is protocol-relative and browsers read it as ` +
          'another host; write the path with a single leading slash, or the absolute ' +
          'URL with respond.redirect.allowExternal: true',
      });
      return;
    }
    // Not a relative path, so the only remaining reading is an absolute URL —
    // and that reading needs the switch, plus a value the parser agrees is one.
    if (redirect.allowExternal !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message:
          `respond.redirect.to "${to}" is not a relative path; redirects to another ` +
          'host need respond.redirect.allowExternal: true',
      });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(to);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `respond.redirect.to "${to}" is neither a relative path nor an absolute URL`,
      });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `respond.redirect.to "${to}" must name an http(s) URL, not ${parsed.protocol}`,
      });
    }
  });

/** Statuses whose body the platform refuses to construct — verified against workerd. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * A fixed answer this route gives instead of forwarding.
 *
 * Exactly one of `redirect` and `status` may be set — a redirect's status is
 * the redirect's own, and folding the two into one field would make
 * `respond: {status: 503, redirect: {…}}` a document with two readings.
 */
const respond = z
  .object({
    /** Send a redirect instead of answering or forwarding. */
    redirect: respondRedirect.optional(),
    /** Answer with this status and (optionally) a body, without contacting an upstream. */
    status: z
      .number()
      .int()
      .min(200)
      .max(599)
      .refine((status) => status !== 101, {
        message: '101 is a protocol switch, not a status a route table can hand out',
      })
      .optional(),
    /** Content-Type of `body`. Required beside it — a body with no type is a guess. */
    contentType: z.string().min(1).optional(),
    /**
     * Literal body served verbatim. UTF-8, as everything this proxy produces is.
     *
     * Size is bounded by the same limit as the rest of the route definition —
     * the admin panel refuses documents over 64 KiB in full (`MAX_DEFINITION_BYTES`
     * in the panel's validate.ts) — rather than by a second number here. A body
     * large enough to matter is a page someone maintains, and it lives in the
     * same document that names it.
     *
     * Refused alongside a status that cannot carry one (204, 205, 304): the
     * platform's `Response` constructor throws on the pairing, and a config
     * that throws on its first request should throw at parse time instead.
     */
    body: z.string().optional(),
    /**
     * Extra response headers. Reserved names are refused for the same reason as
     * in `responseHeaders.set` — the proxy derives them or the runtime owns them.
     */
    headers: z.record(headerName, z.string()).optional(),
  })
  .superRefine((answer, ctx) => {
    const kinds = [answer.redirect, answer.status].filter((v) => v !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `respond must set exactly one of redirect or status (found ${kinds.length})`,
      });
      return;
    }
    if (answer.status !== undefined && answer.body !== undefined) {
      if (NULL_BODY_STATUSES.has(answer.status)) {
        ctx.addIssue({
          code: 'custom',
          path: ['body'],
          message:
            `respond.status ${answer.status} cannot carry a body: the runtime's ` +
            `Response constructor throws on the pairing`,
        });
      }
      if (answer.contentType === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['contentType'],
          message: 'respond.body requires respond.contentType — a body with no type is a guess',
        });
      }
    }
    if (answer.redirect !== undefined && answer.body !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'respond.redirect answers with Location and carries no body',
      });
    }
    if (answer.headers !== undefined) {
      const { canonical, problems } = inspectHeaderNames(
        Object.keys(answer.headers),
        'respond.headers',
        RESERVED_RESPONSE_HEADERS,
      );
      for (const message of problems) {
        ctx.addIssue({ code: 'custom', path: ['headers'], message });
      }
      // On a redirect the target is `respond.redirect.to`; a `headers.location`
      // beside it would give the response two addresses and the one that won
      // would depend on construction order in the middleware.
      if (answer.redirect !== undefined && canonical.has('location')) {
        ctx.addIssue({
          code: 'custom',
          path: ['headers'],
          message:
            'respond.headers may not write "location" on a redirect — the target is ' +
            'respond.redirect.to',
        });
      }
    }
  });

/**
 * A page is a body plus its type and optional headers, all three present or
 * none of the point: a body without a type is a guess, and a page with no body
 * is just the JSON error it was meant to replace.
 */
const errorPage = z
  .object({
    /** The HTML (or text) served in place of the JSON failure. */
    body: z.string().min(1),
    /** Content-Type of `body` — the pairing `respond` requires, page-side too. */
    contentType: z.string().min(1),
    /**
     * Extra headers on the replacement page. Reserved names are refused for
     * the same reason as in `responseHeaders.set`.
     */
    headers: z.record(headerName, z.string()).optional(),
  })
  .superRefine((page, ctx) => {
    const { problems } = inspectHeaderNames(
      Object.keys(page.headers ?? {}),
      'errorPages.headers',
      RESERVED_RESPONSE_HEADERS,
    );
    for (const message of problems) {
      ctx.addIssue({ code: 'custom', path: ['headers'], message });
    }
  });

/**
 * Replacement bodies for the upstream failures jouska itself answers.
 *
 * Only reachable on a route that has an upstream — a route that answers for
 * itself cannot fail to reach one, so the schema rejects the pairing before
 * a page that can never fire ships in the table.
 *
 * The key is the status the failure produced. Only 5xx keys are accepted,
 * because those are the only statuses this lookup ever sees — jouska's own
 * upstream failures are 502 and 504, and the 4xx and 413 the guards produce
 * are refusals, not faults. A key outside that range would be config that
 * cannot take effect, and config that cannot take effect should say so at
 * parse time rather than sit inert.
 *
 * The status is never replaced. A maintenance page served as 200 defeats every
 * monitoring probe that keys on status — the one signal that says "this is
 * broken" — so the failure's status passes through and only the payload does.
 */
const errorPages = z
  .record(z.string().regex(/^[1-5]\d\d$/, 'expected a three-digit HTTP status'), errorPage)
  .superRefine((pages, ctx) => {
    for (const status of Object.keys(pages)) {
      const code = Number(status);
      if (code < 500 || code > 599) {
        ctx.addIssue({
          code: 'custom',
          path: [status],
          message:
            `errorPages.${status}: only 5xx statuses can occur here — jouska's own ` +
            'upstream failures are 502 and 504',
        });
      }
    }
  });

/**
 * Request-ID stamping.
 *
 * jouska resolves one ID per proxied request — the client's `x-request-id` when
 * `trustInbound` admits it, `cf-ray` otherwise, with a UUID as the last resort —
 * and stamps it onto the upstream request, the response the client receives and
 * the proxy event, so the three can be tied together after the fact. Omitting
 * the block keeps all of that with the default resolution: there is no off
 * switch, because a response missing the header is the one case nobody can debug
 * from logs.
 *
 * The block is optional rather than defaulted so a table-wide `defaults` block
 * can still reach routes that said nothing (see `applyDefaults` — a defaulted
 * field is always "stated"). `trustInbound`'s own default covers the rest.
 *
 * The header *name* is fixed rather than configurable. The refusal of
 * `x-request-id` in `requestHeaders` is a parse-time check against a constant
 * set; a per-route name would move it into cross-field validation that has to
 * survive `defaults` folding, to buy a knob nothing calls for.
 */
const requestId = z.object({
  /**
   * Adopt the value the caller sent instead of resolving our own.
   *
   * Off by default: the header then names this request as seen from this
   * proxy, and a caller-chosen one is a chain it does not control. On, it is
   * how one ID spans a multi-hop path — but a caller-controlled string
   * reaching a log line verbatim is log injection, so the value is accepted
   * only if it is 1–64 characters of `[A-Za-z0-9_-]`, and one that fails is
   * replaced rather than repaired.
   */
  trustInbound: z.boolean().default(false),
});

/** Fields shared by a route and the table-wide `defaults` block. */
const routeBehaviour = {
  /** Scheme used to reach the upstream. `http` is for local and in-network origins. */
  scheme: z.enum(['https', 'http']).default('https'),
  /** Strip the matched path prefix before forwarding. */
  stripPrefix: z.boolean().default(false),
  /**
   * Deadline for one attempt to produce **response headers**.
   *
   * Headers only. It used to reach the last byte of the body, because the value
   * was handed to `AbortSignal.timeout` and that signal governs the whole
   * exchange — so a streaming response was cut off mid-flight at a deadline
   * documented as "per-attempt". Verified: an 8-event SSE stream spanning 400ms
   * under `timeoutMs: 150` reached the client as `200 OK` with two events and
   * then a dead socket, and the event reported a successful 200. The body now
   * has deadlines of its own; see `firstChunkTimeoutMs` and
   * `streamIdleTimeoutMs`.
   *
   * The ceiling is 120s rather than 30s because an upstream may be slow to
   * answer at all: a cold-starting container or a queued request can take a
   * minute to produce headers, and there is nothing this proxy can do about it
   * except wait or give up.
   */
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  /**
   * Ceiling on all attempts combined, including backoff — still to headers.
   *
   * Without this, `retries: 3` with `timeoutMs: 30000` lets a single request
   * occupy the proxy for two minutes before returning 504 — measured at 403ms
   * for 4×100ms attempts, so the arithmetic holds in practice.
   *
   * This is a retry budget, which is what the field has always measured, and it
   * deliberately stops at headers. Once a body is streaming there is no
   * whole-response ceiling: nginx has bounded proxied responses by
   * `proxy_read_timeout` — "set only between two successive read operations,
   * not for the transmission of the whole response" — for its entire history,
   * and a total-duration cap is what makes a long streamed answer fail for no
   * reason. The idle deadlines below are the bound instead.
   */
  totalTimeoutMs: z.number().int().positive().max(300_000).default(30_000),
  /**
   * How long to wait for the **first byte of the body** after headers arrive.
   *
   * Separate from `streamIdleTimeoutMs` because the two measure different
   * things: an upstream that thinks for a minute before emitting anything is
   * working, whereas a minute of silence *between* bytes is a dead connection.
   * Collapsing them into one number means either killing the slow starter or
   * waiting out its budget before noticing the dead one.
   *
   * A non-streaming response sends headers and body together, so this never
   * fires for one.
   */
  firstChunkTimeoutMs: z.number().int().positive().max(600_000).default(60_000),
  /**
   * How long the body may go without a byte once it has started.
   *
   * 60s to match nginx's `proxy_read_timeout` default, and measured the same
   * way: between two successive reads, not across the whole response. An
   * upstream that sends keep-alive frames resets it, which is correct — those
   * frames are the upstream saying it is still there.
   *
   * jouska never injects keep-alives of its own. Feeding this deadline from
   * inside the proxy would guarantee it never fires, which is the opposite of
   * knowing whether the upstream is alive.
   */
  streamIdleTimeoutMs: z.number().int().positive().max(600_000).default(60_000),
  /**
   * Extra attempts after the first failure. Only idempotent methods retry.
   *
   * The ceiling exists because the walk is materialised as an array up front,
   * so the number is allocated rather than merely counted. It is otherwise not
   * the operative limit: `totalTimeoutMs` is, and it will end the walk long
   * before a hundredth attempt. nginx leaves the equivalent
   * (`proxy_next_upstream_tries`) unbounded by default for the same reason.
   */
  retries: z.number().int().min(0).max(100).default(0),
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
  /** Method allow-list and body-size ceiling for matched requests. Omit to admit all. */
  requestPolicy: requestPolicy.optional(),
  /** IP allow/deny rules. Omit to admit every address. */
  ip: ipRules.optional(),
  /** Hotlink protection: an allow-list of honoured referring sites. Omit to admit all. */
  referer: referer.optional(),
  /** Rate limiting via the native Cloudflare binding. Omit to disable. */
  rateLimit: rateLimit.optional(),
  /** Signed links: the URL must carry a valid HMAC over path and expiry. Omit to admit all. */
  signedLink: signedLink.optional(),
  /** Identity checks: Cloudflare Access JWT and/or API key. Omit to admit every caller. */
  access: access.optional(),
  /**
   * Request-ID stamping. The ID is resolved per request, stamped onto the
   * upstream request and the response, and reported on the proxy event, so the
   * copies correlate. `trustInbound` is the one decision here — whether a
   * caller may supply it, which is how a multi-hop path shares one ID.
   */
  requestId: requestId.optional(),
  // Spread rather than restated, so the schemas cannot drift between the route
  // and a future restatement. Whole-block replace on merge, like `cors`/`ip`.
  ...authBehaviour,
} as const;

const route = z.object({
  /**
   * Stable handle for this route. Used to merge a code-defined table with a
   * remote one (same id means the code version wins) and, when present, to
   * namespace rate-limit buckets. Routes without an id are never merged.
   */
  id: z.string().min(1).optional(),
  match,
  /** The single-upstream form. Exactly one of `upstream`/`upstreams`/`trafficSplit` may be set. */
  upstream: upstream.optional(),
  /**
   * Ordered failover candidates. Tried in the order written, moving on only
   * for the conditions `failover.on` names. See {@link failover}.
   */
  upstreams: z.array(upstream).min(1).max(MAX_LIST).optional(),
  /** Weighted split across upstreams; the winner is chosen per request. See {@link trafficSplit}. */
  trafficSplit: trafficSplit.optional(),
  /**
   * Policy for walking `upstreams`. Optional here because single-upstream
   * routes have nothing to walk; a route with candidates is normalised to
   * always carry one — see {@link normalizeFailover}.
   */
  failover: failover.optional(),
  /**
   * Policy for remembering failures across requests and skipping a candidate
   * that keeps failing. Optional here because single-upstream routes have
   * nothing to skip; candidate routes are normalised to always carry one.
   */
  outlier: outlier.optional(),
  /**
   * Isolate-level fuses over the load this route may add: a ceiling on the
   * share of requests spent on retries, and a ceiling on concurrent in-flight
   * requests per upstream. Optional because both default to off — a route that
   * states no `limits` behaves exactly as it did before the block existed.
   * See {@link limits}.
   */
  limits: limits.optional(),
  /** How a `trafficSplit` route keeps a caller on their assigned upstream. */
  stickyBy: stickyBy.optional(),
  /**
   * What the split's weighted hash is taken over. Omitted means the caller's
   * address, the behaviour this field was parameterised out of.
   */
  hashBy: hashBy.optional(),
  /**
   * How the hashed key is mapped onto candidates. Omitted means `modulo`, the
   * behaviour this field was parameterised out of.
   */
  hashType: hashType.optional(),
  /**
   * Permit a loopback, private or metadata upstream. Off by default: the
   * upstream is runtime-editable through KV, so an unconstrained value turns a
   * corrupted config into an internal network probe.
   */
  allowPrivateUpstream: z.literal(true).optional(),
  /**
   * Answer for this route at the edge instead of forwarding. See
   * {@link respond} for the two shapes and the refusals around them. Mutually
   * exclusive with every upstream strategy — checked in the table refine below,
   * where the three-way `upstream`/`upstreams`/`trafficSplit` check already
   * runs, because one route cannot both answer and forward. Neither this nor
   * `errorPages` is a `defaults` field: a table-wide `respond` would turn every
   * route into an edge answer, and a table-wide `errorPages` would promise
   * coverage on the very routes that need none.
   */
  respond: respond.optional(),
  /**
   * A background copy of matching requests to a second upstream, whose response
   * is discarded. Not a `defaults` field, like `respond` and `errorPages`: a
   * table-wide mirror would send a copy of everything to one address, which is
   * a statement about the whole table rather than a default. Requires an
   * upstream strategy and is refused on a `respond` route — checked in the
   * table refine beside the pairing above, because a mirror on a route that
   * answers at the edge has no request to copy.
   */
  mirror: mirror.optional(),
  /**
   * Replacement pages for the upstream failures jouska answers itself. See
   * {@link errorPages}; requires an upstream strategy, and never replaces the
   * failure's status code.
   */
  errorPages: errorPages.optional(),
  ...routeBehaviour,
});

/**
 * A route that opted out of the private-upstream refusal, in list form. The
 * per-value schema means every candidate is screened: an array that only
 * checked its first entry would make the second one a route around the SSRF
 * refusal, and that route would only ever be taken when the first origin was
 * down — the moment nobody is watching.
 */
const privateUpstreams = z.array(upstreamAllowingPrivate).min(1).max(MAX_LIST);

/**
 * A route that opted out of the private-upstream refusal, as a weighted split.
 * Every entry is screened for the same reason as `privateUpstreams`.
 */
const privateTrafficSplit = z
  .array(trafficSplitEntry.extend({ upstream: upstreamAllowingPrivate }))
  .min(1)
  .max(MAX_LIST);

/**
 * A route that has opted out of the private-upstream refusal. Parsed as a
 * separate branch because Zod cannot consult a sibling field from within the
 * refinement that would need it.
 */
const privateRoute = route.extend({
  upstream: upstreamAllowingPrivate.optional(),
  upstreams: privateUpstreams.optional(),
  trafficSplit: privateTrafficSplit.optional(),
  allowPrivateUpstream: z.literal(true),
  // The auth endpoint inherits the same exemption as the upstream: a route that
  // declared `allowPrivateUpstream` means in-network auth services are the
  // point, and the strict branch would refuse the URL the same config blessed.
  forwardAuth: authBehaviourPrivate.forwardAuth,
  // The mirror target inherits the exemption with them, for the same reason: a
  // route blessed for in-network upstreams is blessed for copying to one, and
  // refusing the copy there would make the strict branch refuse config the
  // route already declared its intent for.
  mirror: mirrorAllowingPrivate.optional(),
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
    firstChunkTimeoutMs: routeBehaviour.firstChunkTimeoutMs.removeDefault().optional(),
    streamIdleTimeoutMs: routeBehaviour.streamIdleTimeoutMs.removeDefault().optional(),
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
    requestPolicy: routeBehaviour.requestPolicy,
    ip: routeBehaviour.ip,
    referer: routeBehaviour.referer,
    rateLimit: routeBehaviour.rateLimit,
    signedLink: routeBehaviour.signedLink,
    access: routeBehaviour.access,
    // Optional block, applied whole-replace: a table-wide auth policy that a
    // route does not override is what a route not listing any means. Per-key
    // merging here would splice a table-wide `url` under a route-local
    // `failOpen`, and the half-merged block would be nobody's intent.
    forwardAuth: routeBehaviour.forwardAuth,
    // Whole-replace like `cors`: a route not stating `requestId` takes the
    // table-wide one, and per-key merging would splice a table-wide
    // `trustInbound: true` onto a route-local block that expected the default.
    requestId: routeBehaviour.requestId,
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

/**
 * Gives every candidate route its failover policy and outlier policy when it
 * states none.
 *
 * Single-upstream routes are left untouched: `failover` on one is a config
 * error (caught in the cross-field checks), so inventing one there would paper
 * over a mistake — and an outlier policy has nothing to skip. Both policies
 * come parsed through their own schemas, so these defaults and the field
 * defaults cannot drift apart.
 */
const normalizeMultiCandidate = (routes: readonly RouteOutput[]): RouteOutput[] =>
  routes.map((entry) =>
    entry.upstreams !== undefined || entry.trafficSplit !== undefined
      ? {
          ...entry,
          failover: entry.failover ?? DEFAULT_FAILOVER,
          outlier: entry.outlier ?? DEFAULT_OUTLIER,
        }
      : entry,
  );

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

      // A method allow-list with nothing in common with `match.methods` refuses
      // every request the route can match: only requests inside `match.methods`
      // reach the policy check, and none of them is in the allow-list. Like the
      // cache check above, saying so beats leaving an operator to read a 405 for
      // everything as the intended behaviour.
      if (entry.requestPolicy?.allowedMethods !== undefined && entry.match.methods !== undefined) {
        const allowed = entry.requestPolicy.allowedMethods;
        if (!entry.match.methods.some((method) => allowed.includes(method))) {
          ctx.addIssue({
            code: 'custom',
            path: ['routes', index, 'requestPolicy', 'allowedMethods'],
            message:
              `requestPolicy.allowedMethods (${allowed.join(', ')}) and match.methods ` +
              `(${entry.match.methods.join(', ')}) have nothing in common, so every ` +
              `request this route matches is refused with 405`,
          });
        }
      }

      /**
       * A cached response is keyed by URL, not by caller. On a route that
       * authenticates, one caller's answer to "are you allowed" would be handed
       * to the next — the cache is not just wrong here, it is an auth bypass.
       * There is no safe combination to configure, so there is no override: the
       * pairing is refused, and the runtime drops the cache block as a backstop
       * in case an older document still carries it.
       */
      const authFields = [entry.forwardAuth];
      if (entry.cache !== undefined && authFields.some((f) => f !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'cache'],
          message:
            'cache is refused on routes that authenticate: a cached entry is keyed by URL ' +
            "and would serve one caller's authorised response to the next",
        });
      }

      /**
       * The three ways of naming upstreams are alternative strategies, not
       * layers: `trafficSplit` picks a winner before anything is sent, while
       * `upstreams` orders attempts. A route carrying two would make "which
       * upstream" depend on an ordering nobody wrote down, and one carrying
       * none names no upstream at all — so both spellings are refused instead
       * of interpreted. Checks run here rather than on the route schema only
       * because that is where every cross-field rule lives.
       */
      const strategies = [entry.upstream, entry.upstreams, entry.trafficSplit].filter(
        (v) => v !== undefined,
      );

      /**
       * A route that answers for itself has no upstream to consult, so a
       * strategy beside `respond` has no reading — and the reverse pairing is
       * worse than meaningless: `errorPages` only ever fires on a failure the
       * proxy reaches itself, so on a route that answers at the edge it is
       * config that looks like coverage and never runs. The pairing is
       * refused, and `errorPages` stays legal on every upstream route, where
       * it replaces the failure's payload and never its status.
       */
      if (entry.respond !== undefined) {
        if (strategies.length !== 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['routes', index, 'respond'],
            message:
              'respond replaces forwarding entirely; remove the upstream side or the ' +
              'respond side — a route cannot both answer and forward',
          });
          return;
        }
      } else if (strategies.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index],
          message:
            `route must set exactly one of upstream, upstreams or trafficSplit ` +
            `(found ${strategies.length})`,
        });
        return;
      }

      if (entry.errorPages !== undefined && strategies.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'errorPages'],
          message:
            'errorPages requires an upstream — a route with no upstream cannot fail to reach one',
        });
      }

      /**
       * A mirror copies a request the proxy forwards, so it needs an upstream on
       * the same route — which the exactly-one-strategy check above already
       * guarantees for every non-`respond` route. The one hole is `respond`:
       * a route that answers at the edge has no upstream to copy the request
       * to, and the check above returned before a mirror would have been
       * noticed, so it is refused here.
       */
      if (entry.mirror !== undefined && entry.respond !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'mirror'],
          message:
            'mirror requires an upstream — a route that answers at the edge has no request to copy',
        });
      }

      /**
       * `failover` is meaningless without candidates to walk over, `outlier`
       * has nothing to remember failures about, and `stickyBy` without a
       * split has nothing to be sticky about. All are refused rather than
       * silently ignored: config that cannot take effect should say so.
       */
      const hasCandidates = entry.upstreams !== undefined || entry.trafficSplit !== undefined;
      if (entry.failover !== undefined && !hasCandidates) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'failover'],
          message: 'failover requires upstreams or trafficSplit',
        });
      }
      if (entry.outlier !== undefined && !hasCandidates) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'outlier'],
          message: 'outlier requires upstreams or trafficSplit',
        });
      }
      if (entry.stickyBy !== undefined && entry.trafficSplit === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'stickyBy'],
          message: 'stickyBy requires trafficSplit',
        });
      }
      /**
       * `hashBy` and `hashType` describe how a split maps requests onto its
       * candidates, so without a split there is nothing to map — refused rather
       * than silently ignored, like `failover` and `stickyBy` above.
       */
      if (entry.hashBy !== undefined && entry.trafficSplit === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'hashBy'],
          message: 'hashBy requires trafficSplit',
        });
      }
      if (entry.hashType !== undefined && entry.trafficSplit === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'hashType'],
          message: 'hashType requires trafficSplit',
        });
      }
      /**
       * A content key and the sticky cookie are two contradictory intents:
       * hashing on `path` wants "the same resource always lands on the same
       * upstream", the cookie wants "the same caller always lands there". A
       * route carrying both would run whichever the request satisfied first,
       * leaving the other a silent no-op — so the contradiction is refused
       * here rather than interpreted away downstream.
       */
      if (
        entry.stickyBy === 'cookie' &&
        entry.hashBy?.source !== undefined &&
        entry.hashBy.source !== 'ip'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'hashBy'],
          message:
            'stickyBy: "cookie" pins a caller by who they are, which a content hash key ' +
            'contradicts; hash on the caller address (drop hashBy) or drop stickyBy',
        });
      }
      if (entry.trafficSplit !== undefined) {
        const seen = new Set<string>();
        entry.trafficSplit.forEach((item, position) => {
          const authority = splitUpstream(item.upstream).authority;
          if (seen.has(authority)) {
            ctx.addIssue({
              code: 'custom',
              path: ['routes', index, 'trafficSplit', position],
              message:
                `trafficSplit names "${authority}" more than once; sticky ` +
                'callers would all resolve to the first entry regardless of weights',
            });
          }
          seen.add(authority);
        });
      }
    });
  })
  /**
   * Folds the `upstreamHeaders` alias away and hands every candidate route its
   * default failover policy, last, so every check above saw the document as
   * written. Normalization deliberately follows the fold: it invents a
   * `failover` on every candidate route, which would blind the "failover
   * requires upstreams or trafficSplit" check if it ran first.
   */
  .transform((config) => ({
    ...config,
    routes: normalizeMultiCandidate(config.routes.map(foldUpstreamHeaders)) as [
      RouteOutput,
      ...RouteOutput[],
    ],
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
export type RefererConfig = z.output<typeof referer>;
export type SignedLinkConfig = z.output<typeof signedLink>;
export type AccessConfig = z.output<typeof access>;
export type BodyRewriteConfig = z.output<typeof bodyRewrite>;
export type CacheConfig = z.output<typeof cache>;
export type RequestPolicyConfig = z.output<typeof requestPolicy>;
export type RequestIdConfig = z.output<typeof requestId>;
export type ForwardAuthConfig = z.output<typeof forwardAuthSchema>;
export type MirrorConfig = z.output<typeof mirror>;
export type HeaderRulesConfig = HeaderRules;
export type RouteInput = z.input<typeof anyRoute>;
/** Input shape, minus the internal bookkeeping field preprocessing supplies. */
export type ConfigInput = Omit<z.input<typeof documentSchema>, typeof STATED_KEYS_FIELD>;

/** Validates and applies defaults. Throws `z.ZodError` on invalid input. */
export const defineConfig = (input: ConfigInput): Config => configSchema.parse(input) as Config;

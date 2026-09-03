# jouska

Reverse-proxy middleware for [Hono](https://hono.dev) on Cloudflare Workers.

A declarative route table maps incoming requests to upstreams, and the response
is rewritten so the visitor never leaves the proxy: redirects, cookies, and
in-page links all point back at your own hostname.

## Why a middleware, not a framework

Routing and middleware pipelines are solved problems, so jouska does not
reimplement them — it plugs into Hono, and delegates CORS, CIDR matching and
rate limiting to Hono's own middleware and Cloudflare's native binding.

What it does own is the proxying itself:

| Concern                                         | Where it lives                   |
| ----------------------------------------------- | -------------------------------- |
| Route table matching (host, path, method)       | `src/router.ts`                  |
| Header forwarding, deadlines, bounded retries   | `src/internal/forward.ts`        |
| `Location` / `Set-Cookie` / validator rewriting | `src/internal/headers.ts`        |
| Streaming body rewriting                        | `src/internal/body.ts`           |
| Upstream response caching                       | `src/internal/response-cache.ts` |
| Geo, IP and rate-limit guards                   | `src/internal/guards.ts`         |
| Access control (CF Access JWT, API keys)        | `src/internal/access.ts`         |
| Config schema, normalisation and validation     | `src/config.ts`                  |

## Install

```sh
npm i jouska hono
```

`hono` is a peer dependency, so your app controls its version.

## Usage

```ts
import { Hono } from 'hono';
import { defineConfig, jouska } from 'jouska';

const config = defineConfig({
  routes: [
    // API passthrough: strip the prefix, retry idempotent requests twice.
    { match: { path: '/openai' }, upstream: 'api.openai.com', stripPrefix: true, retries: 2 },

    // Upstream that serves its API under a base path.
    { match: { path: '/ai' }, upstream: 'api.example.com/openai-compatible', stripPrefix: true },

    // Full site mirror: rewrite links in HTML so navigation stays on the proxy.
    { match: { host: 'mirror.example.com' }, upstream: 'origin.example.com', bodyRewrite: {} },
  ],
});

const app = new Hono();
app.use('*', jouska({ config }));

// Unmatched requests fall through, so your own handlers still work.
app.get('/health', (c) => c.text('ok'));

export default app;
```

Routes are evaluated in order and the first match wins.

## Route options

| Option                 | Default   | Meaning                                                                           |
| ---------------------- | --------- | --------------------------------------------------------------------------------- |
| `id`                   | —         | Stable handle. Used for `byId` merges and rate-limit buckets.                     |
| `match.host`           | —         | Host to match. `*.example.com` matches subdomains, not the apex.                  |
| `match.path`           | —         | Path prefix, matched on segment boundaries.                                       |
| `match.methods`        | all       | Restrict the route to specific methods.                                           |
| `match.headers`        | `[]`      | Request-header conditions; see Match conditions below.                            |
| `match.query`          | `[]`      | Query-parameter conditions; see Match conditions below.                           |
| `match.cookies`        | `[]`      | Cookie conditions; see Match conditions below.                                    |
| `upstream`             | —         | `host`, `host:port` or `host/base/path`. No scheme.                               |
| `upstreams`            | —         | Ordered candidates for failover; see Failover and traffic splitting.              |
| `trafficSplit`         | —         | Weighted split entries; see Failover and traffic splitting.                       |
| `respond`              | —         | Answer at the edge instead of forwarding; see Edge answers.                       |
| `errorPages`           | —         | Replace the payload of an upstream failure; see Edge answers.                     |
| `failover`             | see text  | Switch policy and attempt cap for the multi-candidate forms.                      |
| `outlier`              | see text  | Passive ejection of failing candidates; see Outlier ejection.                     |
| `stickyBy`             | —         | `'cookie'`: split-assigned callers keep their upstream via a cookie.              |
| `hashBy`               | caller IP | What the split's weighted hash is taken over; see Failover and traffic splitting. |
| `hashType`             | `modulo`  | How the hashed key maps onto candidates: `modulo`, or a `consistent` ring.        |
| `scheme`               | `https`   | Scheme used to reach the upstream.                                                |
| `allowPrivateUpstream` | off       | Permit a loopback, private or metadata upstream.                                  |
| `stripPrefix`          | `false`   | Remove the matched prefix before forwarding.                                      |
| `timeoutMs`            | `10000`   | Per-attempt deadline for **response headers**. Max 120s.                          |
| `totalTimeoutMs`       | `30000`   | Ceiling on all attempts to headers, including backoff. Max 300s.                  |
| `firstChunkTimeoutMs`  | `60000`   | Wait for the body's first byte after headers arrive.                              |
| `streamIdleTimeoutMs`  | `60000`   | Longest silence between body bytes once it has started.                           |
| `retries`              | `0`       | Extra attempts. Only idempotent methods retry.                                    |
| `retryBackoffMs`       | `100`     | Delay before the first retry, doubled for each subsequent one.                    |
| `rewriteHeaders`       | `true`    | Rewrite `Location`, `Refresh` and `Set-Cookie` onto the proxy.                    |
| `manualRedirect`       | `true`    | Ask for the redirect instead of following it upstream.                            |
| `websocket`            | `true`    | Forward WebSocket upgrades.                                                       |
| `bodyRewrite`          | off       | Streaming body rewriting; see below.                                              |
| `blockCountries`       | `[]`      | ISO 3166-1 alpha-2 codes refused with 403.                                        |
| `allowCountries`       | —         | When set, only these are admitted. Fails closed on an unknown origin.             |
| `upstreamHeaders`      | `{}`      | Alias for `requestHeaders.set`; see Header rules.                                 |
| `requestHeaders`       | off       | Headers to write or delete on the way upstream; see Header rules.                 |
| `responseHeaders`      | off       | Headers to write or delete on the way back; see Header rules.                     |
| `cache`                | off       | Upstream response caching; see Response caching.                                  |
| `requestPolicy`        | off       | Method allow-list and body size cap; see Guards.                                  |
| `cors`                 | off       | CORS handling; see Guards.                                                        |
| `ip`                   | off       | IP allow/deny rules; see Guards.                                                  |
| `rateLimit`            | off       | Rate limiting via the native binding; see Guards.                                 |
| `access`               | off       | Route-level identity checks (Cloudflare Access JWT, API keys); see Guards.        |

A `defaults` block at the top of the table supplies any of the behavioural
fields for every route that does not state its own, so a table of twenty routes
need not repeat `timeoutMs` twenty times:

```ts
defineConfig({
  defaults: { timeoutMs: 5_000, retries: 2 },
  routes: [
    { match: { path: '/a' }, upstream: 'a.example.com' },
    { match: { path: '/b' }, upstream: 'b.example.com', timeoutMs: 20_000 },
  ],
});
```

A route that states a field keeps its value; `defaults` only fills gaps.

`upstreamHeaders`, `requestHeaders` and `responseHeaders` fill gaps rule by rule,
because they are bags of independent headers rather than single settings: a route
adding a header of its own keeps the table-wide ones, and on a name collision the
route still wins. Their `remove` lists are unioned — a table-wide "strip the
`Server` header this upstream leaks" that any route could switch off by adding an
unrelated rule of its own would be a control lost to an edit that never mentioned
it. The cost is that a route cannot opt _out_ of a table-wide removal; move the
rule onto the routes that want it instead.

The policy blocks — `cors`, `ip`, `rateLimit`, `bodyRewrite`, `cache` — are
replaced whole, since merging halves of two of them would produce a policy neither
the table nor the route wrote.

### What is forwarded

The client's own headers are forwarded, minus the hop-by-hop set and anything
the request's `Connection` header names — those describe a single connection and
relaying them would be a protocol violation, as well as a way to smuggle a
header past a middlebox. `accept-encoding` is dropped so bodies arrive
uncompressed, which is what makes streaming body rewriting possible.

On top of that every forwarded request carries `Host` (set to the upstream),
`X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`. The last is
derived from Cloudflare's `cf-connecting-ip` and **overwrites** any value the
client sent, so the upstream sees the real visitor address rather than a forged
chain; with no `cf-connecting-ip` to trust, the header is removed rather than
passed through. A route may neither write nor delete any of these four — the
config is rejected rather than silently ignored. See Header rules for every name a
route cannot touch, and why each one is on the list.

### Header rules

`requestHeaders` and `responseHeaders` name headers to write and headers to
delete, in one direction each:

```ts
{
  match: { path: '/api' },
  upstream: 'api.example.com',
  requestHeaders: {
    set: { 'x-api-version': '2026-09' },
    remove: ['x-legacy-client'],
  },
  responseHeaders: {
    set: { 'x-content-type-options': 'nosniff' },
    remove: ['server', 'x-powered-by'],
  },
}
```

Values are literal strings. There is no interpolation — `${host}` would be a
second grammar with its own escaping rules — and credentials belong in Secrets
Store rather than in a route table a panel can display.

**Not a callback, deliberately.** The obvious alternative is an `onRequest` /
`onResponse` hook, which is how [reflare](https://github.com/latticehr/reflare)
(the project this was forked from) solves the same problem. jouska's route table
lives in KV or D1 and is edited from a panel, so a JS hook there would mean
"anyone who can edit the route table can run arbitrary code in the Worker". These
two operations cover what operators actually reach for and open no such surface.

**Order is fixed, and tested.** On the way out, the rules run after the
hop-by-hop strip and before jouska writes the forwarding headers, so a rule cannot
forge `Host` or `X-Forwarded-For` even if the refusals below were bypassed. On the
way back, the rules run **last** — after `Location`, `Refresh`, `Set-Cookie` and
`Content-Location` have been rewritten onto the proxy, and after the body
validators and CSP have been stripped.

Running last is a trade-off with a sharp edge, and it is a choice rather than an
accident: `responseHeaders.set` can put an upstream URL back into `Location` and
send the visitor off the proxy, or restore a `Content-Security-Policy` that blocks
the rewritten page from loading its own assets. The alternative — operator rules
first — makes every rule silently unreliable, which is worse for a value someone
wrote on purpose. Both fields are flagged in the admin panel instead.

Within one direction, deletions are applied before writes. A name that appears in
both `set` and `remove` is refused, so the order is not observable today; it is
written this way because "clear it, then write it" is the only reading that stays
correct if that ever relaxes.

**Names a route cannot touch.** Each of these is refused at parse time rather
than ignored at request time, because a rule that cannot take effect should say so:

| Direction | Names                                                              | Refused for                                                                                                                           |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Request   | `host`, `x-forwarded-host`, `x-forwarded-proto`, `x-forwarded-for` | jouska derives them from the request; a value here would be overwritten.                                                              |
| Request   | the hop-by-hop set, `content-length`                               | They describe this one connection. `transfer-encoding` is the sharpest case — a forged one is where request smuggling starts.         |
| Request   | `accept-encoding`                                                  | Deleted so bodies arrive uncompressed. Writing it back leaves the body rewriter scanning compressed bytes and silently doing nothing. |
| Request   | `upgrade`, `sec-websocket-*`                                       | The `websocket` flag governs these. Writing them back would let an upgrade through on a route that turned it off.                     |
| Response  | the hop-by-hop set, `content-length`, `content-encoding`           | The runtime recomputes them for the hop out; a value here describes bytes the client is not about to read.                            |
| Response  | `set-cookie`                                                       | `Headers.set` replaces _every_ value under a name, so writing one cookie discards all of the upstream's — writing it is deleting it.  |
| Response  | `location`, `content-location`, `refresh` (deletion only)          | Deleting one makes a redirect vanish or loses a rewrite quietly. Writing them is permitted; see the trade-off above.                  |

Two spellings of one name in the same map (`X-Foo` and `x-foo`) are refused too:
header names are case-insensitive, so that is one rule with two values, and which
survives would depend on key order.

**`upstreamHeaders` is an alias** for `requestHeaders.set`, kept so a route table
written before `requestHeaders` existed keeps working. It is folded into
`requestHeaders.set` after `defaults` are applied and does not survive into the
parsed route, so "both fields exist and each half takes effect" cannot happen. A
name written in both places with _different_ values is refused, since nothing in
the document says which should win; the same value twice is a harmless duplicate
and is merged. The alias carries exactly the refusals above — validating it more
loosely would have made renaming a way around them.

### Normalisation and matching

Config values are normalised when they are parsed, not when they are compared.
Hosts, methods and country codes are case-folded once, so
`blockCountries: ['cu']` blocks `CU` instead of quietly matching nothing.

A path prefix is matched against every spelling an upstream might resolve to the
same resource — the literal path, its percent-decoded form, with repeated
separators collapsed, and with path parameters removed. A route matches if any of
them do, so `/%61dmin`, `//admin` and `/admin;x` cannot slip past a route
guarding `/admin` and fall through to a permissive one. The literal path is what
gets forwarded: re-encoding a decoded path is not round-trip safe.

Matching reads the host from the request URL rather than the `Host` header. On
Workers the URL host is what the platform routed on and cannot be forged.

### Match conditions

Beyond host, path and method, a route can condition on request headers, query
parameters and cookies. Three families, three operators:

| Operator         | Holds when                                                                     |
| ---------------- | ------------------------------------------------------------------------------ |
| `equals: 'v'`    | the value is exactly `v`; an empty string matches `X-Foo:` — present but empty |
| `prefix: 'p'`    | the value starts with `p`                                                      |
| `present: true`  | the name is there at all, even with an empty value                             |
| `present: false` | the name is absent — an empty value still counts as present                    |

```ts
{
  match: {
    path: '/',
    headers: [{ name: 'x-canary', equals: 'on' }],
    cookies: [{ name: 'beta', present: true }],
  },
  upstream: 'canary.example.com',
}
```

Conditions AND within a family and across families. There is no OR inside a
route: "either" is spelled as two routes — the table is ordered and first match
wins, so ordering is the semantics, and an unconditional route above a
conditional one will take its traffic (the publish preview warns about exactly
that).

Values are case-sensitive: `X-Env: Prod` and `prod` are two different values,
and folding them would let a canary route quietly match production traffic.
Header _names_ fold to lowercase, because header names are case-insensitive on
the wire; query and cookie names do not fold, because those specs treat them as
case-sensitive.

A repeated name matches its first occurrence: `Headers.get` returns the
combined value of repeated headers, and query parameters and cookies read the
first value under the name.

**This is routing, not authentication.** Anyone can send `x-canary: on`, so a
condition selects traffic, it never restricts it — gate access at the upstream.

When a route with header or cookie conditions also enables `cache`, the
request's values for every named header and cookie are folded into the cache
key, so the two branches of a split never share an entry. The cost is hit rate:
each distinct value is a distinct key, and the publish preview says so. Query
conditions need no folding — the query string is already part of the URL the
key is built from.

### Retries and deadlines

Retries replay only **network failures and timeouts**. An HTTP 5xx is a normal
response and is returned as-is on the first attempt: replaying it would pile
load onto a struggling origin for no expected benefit. A client that hangs up is
not retried either — nobody is waiting — and cancels the upstream request rather
than leaving it to run out its deadline.

Attempts back off exponentially from `retryBackoffMs`, and `totalTimeoutMs`
bounds them all together. Without that ceiling, `retries: 3` with
`timeoutMs: 30000` could occupy the proxy for two minutes before returning 504.

Note that a request carrying a body is never retried, whatever `retries` says:
the body is a stream, the first attempt consumes it, and a second attempt would
have nothing to send. So on a route serving `POST` — an API proxy, most
obviously — `retries` is inert. It is not a bug to be fixed; a stream cannot be
replayed.

### Streaming deadlines

Four deadlines, not two, because a response has four phases worth bounding
separately:

| Phase                               | Field                 | Default |
| ----------------------------------- | --------------------- | ------- |
| One attempt, up to response headers | `timeoutMs`           | 10s     |
| All attempts, up to headers         | `totalTimeoutMs`      | 30s     |
| Headers → the body's first byte     | `firstChunkTimeoutMs` | 60s     |
| Between two body bytes              | `streamIdleTimeoutMs` | 60s     |

**There is deliberately no ceiling on the body's total duration.** As long as
bytes keep arriving, the response keeps streaming — for minutes, if that is how
long the upstream takes. This is the shape nginx has used throughout its history:
`proxy_read_timeout` is "set only between two successive read operations, not for
the transmission of the whole response", and nginx has no whole-response bound at
all. A total-duration cap is what makes a long streamed answer fail for no reason
the operator can act on.

`timeoutMs` bounds headers **only**. It used to reach the last byte of the body,
because the value was handed to `AbortSignal.timeout` and that signal governs the
whole exchange. The consequence was silent: an 8-event SSE stream spanning 400ms
under `timeoutMs: 150` reached the client as `200 OK`, two events, and then a
dead socket — and `onProxy` reported a successful 200, because by then it was one.

The first-byte and between-bytes deadlines are separate numbers because they
catch different failures. An upstream that sends nothing for a minute before its
first token is working; a minute of silence _between_ tokens is a dead
connection. One number for both either kills the slow starter or waits out its
budget before noticing the corpse. Keep-alive frames from the upstream reset the
idle deadline, which is correct — those frames are the upstream saying it is
still there. jouska never injects keep-alives of its own: feeding the deadline
from inside the proxy would guarantee it never fires.

A route proxying a streaming API therefore wants its own numbers:

```ts
{
  match: { host: 'api.example.com' },
  upstream: 'api.anthropic.com',
  timeoutMs: 60_000,            // a cold-starting upstream can be slow to answer at all
  totalTimeoutMs: 60_000,       // retries: 0, so the same figure
  firstChunkTimeoutMs: 300_000, // five minutes for a reasoning model's first token
  streamIdleTimeoutMs: 60_000,  // after that, a minute of silence means it died
  // no bodyRewrite, no cache — see Streaming media below
}
```

When a body deadline does expire, the headers are long gone, so the failure
cannot be a status code: the client's stream errors instead, and
`ProxyEvent.stream` resolves with `first_chunk_timeout` or `idle_timeout`. That
promise is the only place a cut stream is visible — `status` will read `200` for
it. The upstream connection is cut at the same moment, so a metered API stops
generating into a stream nobody will read.

### Streaming media

`text/event-stream` and the line-delimited JSON types (`application/x-ndjson`,
`application/jsonl`, `application/x-jsonlines`, `application/stream+json`) are
never rewritten and never cached, whatever a route's `bodyRewrite.contentTypes`
or `cache.contentTypes` say. Not a default to widen — a hard list, because
neither operation has a correct form on a stream:

- **Rewriting holds bytes back.** The literal-replacement pass withholds the tail
  of every chunk, one byte short of the longest needle, so a match straddling a
  chunk boundary is not split. On a framed stream that cuts inside the frame:
  verified against a real SSE upstream, a route with one `replace` rule delivered
  `"da"`, then `"ta: {"i":0}

da"`, and so on — every chunk severed
  mid-`data:`, which no `EventSource` can parse.

- **Caching replays.** A stored answer served to the next caller is that caller
  reading somebody else's stream, generated once, with none of their own tokens
  produced. Verified: `cache.contentTypes: ['text/']` stored an SSE response and
  reported `hit` on the following request.

A skipped rewrite reports `rewriteSkipped: 'streaming_media'`, so the reason is
visible rather than looking like a route that forgot to configure one.

### Failover and traffic splitting

A route names its upstreams in exactly one of three ways, and every request
still resolves to exactly one of them:

```ts
{ match: { path: '/x' }, upstreams: ['a.example.com', 'b.example.com'] }
{ match: { path: '/x' }, trafficSplit: [
    { upstream: 'v2.example.com', weight: 1 },
    { upstream: 'v1.example.com', weight: 9 },
  ] }
```

`upstreams` is an ordered list: the first is primary, the rest are backups. The
walk moves to the next candidate only after the previous one failed with a
condition the route's `failover.on` names — `timeout`, `unreachable`, or the
opt-in `'5xx'` — and only while the request is replayable, so an idempotent
bodyless GET walks, and a POST with a body or a WebSocket handshake gets one
attempt at the primary. `failover.maxAttempts` caps the walk — it defaults to
every candidate the route declares — and `totalTimeoutMs` bounds it in time. Each candidate is tried once; listing the
same upstream twice is how a same-upstream retry is spelled in a failover list.

A 5xx is a normal response and ends the walk unless `'5xx'` is in the policy.
With it, the last 5xx seen is kept as the fallback: if every candidate fails
this way, the client receives the final one, body and all, rather than an
invented 502. Rewrites and the `onProxy` report follow the candidate that
actually answered — a response reached through a backup carries the backup's
host, and a failure report names the last candidate tried.

`trafficSplit` is a distribution, not an order. Callers are assigned by hashing
a stable key into the weight space — deterministic, no state, and reproducible
from the request alone. The key is the caller's `cf-connecting-ip` by default;
`hashBy` widens it to the request `path`, the full `url`, a named `header`, a
named `cookie`, or a `query` parameter — so the same tenant header always lands
on the same upstream, whatever address it called from. `hashType` chooses how
the hashed key maps onto candidates. The default `modulo` divides the weight
space as `hash()` does, and is bit-identical to the behaviour before `hashBy`
existed; `consistent` builds a ketama-style ring over the candidates, which
moves only the keys that land in the arc a candidate owned — so removing a
candidate re-assigns its own share and nothing else, and adjusting a 95/5
canary to 9/1 does not re-shuffle the entire audience the way `modulo` would.

A content key that turns up missing on a request — the header absent, the
cookie not sent, the parameter empty-by-absence — falls back to the address
rather than to a constant, so those callers stay spread out instead of piling
into one bucket; `scope` in the proxy event reads `ip` in that case, because it
reports what was actually hashed, not what was configured. The address itself
missing leaves nothing to hash and reports `none`.

A weighted split is a distribution approximation, not a guarantee. Hash-based
assignment is exact only when the key space is fine-grained and plentiful; keys
of high cardinality skew the measured split away from the declared weights, and
a `path` key over a small set of documents can turn a declared 95/5 into a
measured 100/0. `consistent` rings soften this but do not remove it.

With `stickyBy: 'cookie'`, a newly assigned caller receives a host-only
`__jouska_upstream` cookie naming its upstream, and presents it back on later
requests; a cookie naming an upstream the split no longer lists is re-assigned.
The split winner is the walk's primary: failover from it continues into the
other participants in declared order. `failover`, `stickyBy`, `hashBy` and
`hashType` are route-level only — they cannot be set in `defaults`.

### Edge answers

`respond` replaces forwarding entirely. A route either names an upstream (in one
of the three ways above) or answers for itself, never both — the config is
refused when the two appear together, because a route that can answer has no
reason to forward and a route that forwards cannot promise the answer:

```ts
// Maintenance page for the whole site, guards still applying.
{ match: { host: 'app.example.com' },
  respond: {
    status: 503,
    contentType: 'text/html; charset=utf-8',
    body: '<h1>Back soon</h1>',
    headers: { 'retry-after': '1800' },
  } },

// Redirect: the old docs path moves, everything under it follows.
{ match: { path: '/docs' },
  respond: { redirect: { to: '/handbook', status: 301 } } },
```

`respond` carries exactly one of `redirect` or `status`. `redirect` defaults to
301 and admits only 301, 302, 303, 307 and 308 — the statuses that carry a
redirect instruction rather than a cache validator. Its target must be a
relative path: a redirect to another host is an open redirect waiting for one
corrupted value, so it needs `respond.redirect.allowExternal: true` written
beside it, and even then the target has to be a real `http(s)` URL. Targets like
`//elsewhere.example/x` are refused outright — browsers read the leading
double slash as a host, so the config says so instead of guessing.

A `status` answer runs through the runtime's `Response` constructor, which
refuses a body on 204, 205 and 304 and refuses any status outside 200–599; the
config refuses the same pairings up front with a message naming the reason. A
body requires a `contentType` beside it — a body with no type is a guess — and
`headers` carries the rest, subject to the same reserved-name check as the
proxy's own response headers (`content-length`, `set-cookie`, `transfer-encoding`
and friends are refused, and `location` is refused beside a `redirect`, whose
target is `redirect.to`). The same 64 KiB route-definition ceiling the panel
enforces bounds the body; a route table is not the place for an asset.

`errorPages` is the counterpart on a route that **does** forward. When jouska
itself fails to reach the upstream — the 502 for unreachable and the 504 for
timeout — the page named for that status replaces the error payload and its
headers, and the status is left alone:

```ts
{ match: { path: '/api' }, upstream: 'origin.example.com',
  errorPages: {
    502: { body: '<h1>Upstream down</h1>', contentType: 'text/html; charset=utf-8' },
    504: { body: '<h1>Slow upstream</h1>', contentType: 'text/html; charset=utf-8' },
  } }
```

Only 5xx keys are accepted, because 502 and 504 are the only statuses jouska's
own failure path produces here; a 404 page would promise coverage for an
upstream answer that is not a failure at all. The status survives because it is
the only truthful part of the exchange — the upstream is still as broken as the
status says, and a 200-wrapped maintenance page would poison every health check
reading the route. `errorPages` cannot appear on a `respond` route, which has no
upstream to fail to reach.

Both kinds of answer are produced after the guard chain: a `respond` route with
`blockCountries` still returns 403, and the CORS block still wraps the answer.
The panel flags a `respond` route and the external-redirect switch as high
danger on publish — a maintenance page left in place takes real traffic offline
with nothing upstream to notice.

### Outlier ejection

The failover walk has no memory between requests: a dead primary is paid for in
full — `timeoutMs`, usually ten seconds — by every visitor, until it comes back.
The `outlier` block gives the route a memory. Failures that move the walk — a
`timeout` or `unreachable` named by `failover.on`, an opted-in `'5xx'` — count
against the candidate that produced them; a client hanging up never counts. Once
a candidate has failed `outlier.consecutiveFailures` times in a row (default 3),
it is skipped at the start of the walk for `outlier.ejectSeconds` (default 30),
so the next visitor goes straight to the backup. Any answer under 500 clears the
count; the ejection lifts itself when the window expires, and no redeploy is
involved on either end.

The policy is on by default for multi-candidate routes and cannot be set on a
single-upstream route, where there is no backup to prefer. When every candidate
is out, the walk still tries the head of the declared order — ejection reorders,
it never makes a route unreachable.

The memory lives in the isolate that handled the request, like the native rate
limit binding's per-datacenter counting: each isolate learns of a dead upstream
on its own, and a fresh isolate pays the timeout again once. That is the
deliberate trade for not standing up shared state; what the approximation costs
is bounded by `ejectSeconds`.

The `onProxy` event carries `ejected` — the candidates this request declined to
try — which answers "why did this request go straight to B" for an operator
watching a healthy backup answer first.

### Body rewriting

`bodyRewrite` accepts `rewriteLinks` (default `true`), `contentTypes` (default
`['text/html']`), `rewriteStyles` (default `true`), `replace` (literal
`from`/`to` pairs), and `fallbackCharset`.

HTML goes through the native `HTMLRewriter`, which rewrites URL-bearing
attributes — including `srcset`, `imagesrcset`, `ping`, `cite`, `data` and
`formaction` — and, with `rewriteStyles`, also `url()` references inside
`<style>` blocks and inline `style` attributes, plus the target of a
`<meta http-equiv="refresh">`. Text nodes outside `<style>` are left alone:
rewriting prose or inline script bodies risks corrupting them for no
navigational benefit. Other allowed text types go through a streaming replacer
that handles matches straddling chunk boundaries.

Each candidate URL is parsed and its host compared, rather than substituted as a
substring. Substring replacement rewrote `https://origin.test.evil.com/x` into
`https://your-proxy.test.evil.com/x`, which both breaks the link and puts the
proxy's own name inside a domain someone else controls.

Replacements are applied in a single pass, so rules never cascade into one
another: `{a→b, b→c}` will not turn `a` into `c`.

A body whose charset the runtime can decode is transcoded to UTF-8 and its
`Content-Type` corrected. One it cannot decode is passed through untouched:
decoding GB2312 bytes as UTF-8 turns every character into U+FFFD, so relaying
them verbatim is the only safe answer. `fallbackCharset` covers both cases where
there is no usable label to go on — an upstream that declares nothing, and one
that declares a charset this runtime cannot decode. If the fallback is not
decodable either, the body is still passed through rather than transcoded with a
charset nobody asked for.

Rewriting also drops the headers that describe the body the upstream sent:
`Content-Length`, and the validators `ETag` and `Last-Modified`. Keeping a
validator means the client's next request carries `If-None-Match`, the upstream
answers 304, and the client then serves the **unrewritten** body from its own
cache — the rewrite silently undone on every subsequent visit. nginx's
`sub_filter` clears both for the same reason.

`Content-Security-Policy` and `Content-Security-Policy-Report-Only` are dropped
too. An upstream CSP references the upstream's own origin in directives like
`img-src` or `connect-src`; once those URLs are rewritten onto the proxy, the
policy would block the page from loading its own rewritten resources. Rewriting
CSP itself is a separate grammar with its own footguns, so it is dropped rather
than half-fixed — the proxy has already taken responsibility for the body's URLs.

Responses that carry no rewritable body are passed through: 204, 304, and 206.
A 206 is a byte range, so changing its length would contradict the
`Content-Range` the client is using to assemble the whole resource.

Whether any of this ran on a given response is not something to infer from the
page: the `onProxy` event reports `bodyRewritten`, `rewriteSkipped` and
`redirectRewritten`. See Observability below.

### WebSockets

An upgrade is forwarded with its handshake headers intact and the 101 response is
relayed as-is. It cannot be rewrapped: `new Response` refuses any status outside
200–599, and rewrapping would drop the socket even if it did not. Upgrades are
never retried, since a handshake cannot be replayed.

## Config precedence

A route table can be written in code or stored remotely (KV, D1, an admin
panel). `resolveConfig` combines them, and **code always wins**:

```ts
import { resolveConfig, jouska } from 'jouska';

export default {
  async fetch(request, env) {
    const config = resolveConfig({
      code: { routes: [{ id: 'core', match: { path: '/api' }, upstream: 'api.example.com' }] },
      remote: await env.CONFIG.get('routes', 'json'),
      merge: 'byId',
      onRemoteError: (error) => console.error('remote config rejected', error),
    });
    const app = new Hono();
    app.use('*', jouska({ config }));
    return app.fetch(request, env);
  },
};
```

Code wins by design: the code-defined table lives in git, is reviewable and
revertable, and keeps working when the remote store is unreachable or has been
filled with something broken. Runtime config offers none of that.

| `merge`             | Behaviour                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- |
| `replace` (default) | A code table replaces the remote one wholesale. Predictable.                            |
| `byId`              | Routes merge by `id`; code wins ties and is ordered first. Remote-only routes are kept. |

Failure handling is asymmetric on purpose: invalid **code** config throws,
because that is a programming error and should fail loudly; invalid **remote**
config is discarded and reported through `onRemoteError`, so a corrupt table
cannot take the proxy down.

## Reading config from a store

Reading the config store on every request does not survive the free tier. KV
allows **100,000 reads per day**, so a site serving two requests per second
exhausts the allowance in half a day, after which reads fail and the proxy goes
down with them.

`createConfigCache` keeps the resolved config in isolate memory, turning "one
read per request" into "one read per isolate per TTL":

```ts
import { createConfigCache, resolveConfig, jouska } from 'jouska';
import { Hono } from 'hono';

const cache = createConfigCache({
  ttlMs: 60_000,
  onReloadError: (error) => console.error('config reload failed', error),
  load: async () =>
    resolveConfig({
      code: { routes: [{ id: 'core', match: { path: '/api' }, upstream: 'api.example.com' }] },
      remote: await CONFIG_KV.get('routes', 'json'),
      merge: 'byId',
    }),
});

export default {
  async fetch(request, env) {
    const app = new Hono();
    app.use('*', jouska({ config: await cache.get() }));
    return app.fetch(request, env);
  },
};
```

| Approach          | KV reads per day  | Free tier supports    |
| ----------------- | ----------------- | --------------------- |
| Read per request  | one per request   | ~100k requests        |
| 60s isolate cache | ~1440 per isolate | effectively unbounded |

Two behaviours are load-bearing: concurrent cache misses share a single load
(otherwise a cold burst issues one read per request, defeating the cache), and a
failed refresh keeps serving the previous config (a briefly unreachable store
must not take the proxy down).

The staleness this introduces is bounded by `ttlMs`, which defaults to 60
seconds. That default is chosen to match the platform: KV is eventually
consistent, and Cloudflare documents that a write may take "up to 60 seconds or
more" to become visible in other locations. So a shorter TTL buys little real
freshness while multiplying reads — the propagation delay dominates either way.

End to end, a config change goes live within roughly `ttlMs` plus KV's own
propagation, so budget on the order of two minutes rather than instantly.

### Where the document lives

`fromKV` and `fromEnvVar` read the document; `firstAvailable` layers them.

**KV** — one key holding one JSON document. In the Cloudflare dashboard this is
a text box containing the JSON, so it can be read and edited by hand. Unwritten
fields take their defaults, so a stored document stays short:

```json
{
  "version": 1,
  "routes": [
    {
      "id": "openai",
      "match": { "path": "/openai" },
      "upstream": "api.openai.com",
      "stripPrefix": true
    }
  ]
}
```

**Environment variable** — the same document, as a `vars` entry. Both shapes a
Worker can receive are accepted, because they are not interchangeable: a JSON
object declared in wrangler config arrives already parsed, while a variable
added by hand in the dashboard can only ever be a string.

```jsonc
{
  "vars": {
    "JOUSKA_CONFIG": {
      "version": 1,
      "routes": [{ "match": { "path": "/openai" }, "upstream": "api.openai.com" }],
    },
  },
}
```

Layer them so a runtime edit wins and the deployment carries a fallback:

```ts
const source = firstAvailable(
  [fromKV(env.CONFIG, 'routes', { cacheTtlSeconds: 300 }), fromEnvVar(env, 'JOUSKA_CONFIG')],
  (error, index) => console.error(`config source ${index} failed`, error),
);
const cache = createConfigCache({
  load: async () => resolveConfig({ code: { routes: [...] }, remote: await source() }),
});
```

A source that throws is treated as absent, so one broken store cannot mask a
working one; the error reaches the callback.

`cacheTtlSeconds` sets how long KV may serve the value from the edge cache
(minimum 30, KV's own default 60). It lowers latency but not billed operations:
Cloudflare states that all KV operations incur charges and makes no exception
for cache hits, so do not budget read quota assuming cached reads are free —
`createConfigCache` is what reduces the number of reads.

#### KV or an environment variable

|           | KV                                 | Environment variable                |
| --------- | ---------------------------------- | ----------------------------------- |
| Editing   | Write the key; live within `ttlMs` | Redeploy the Worker                 |
| Dashboard | Text box, editable                 | Editable, but see below             |
| History   | None by itself                     | None                                |
| Read cost | Counts against the KV allowance    | Free — it is part of the deployment |

Environment variables are deployment configuration rather than data: changing
one means redeploying, and there is no history.

Editing one in the dashboard is also unsafe by default. Cloudflare's Wrangler
docs state: "If you change your environment variables in the Cloudflare
dashboard, Wrangler will override them the next time you deploy." So with CI
deploying on every push, a hand-edited config silently reverts. Setting
`keep_vars = true` in the Wrangler configuration opts out of that, which makes
dashboard editing viable — at the cost of the Wrangler config no longer being
the source of truth for those values.

Use a variable for a table that changes together with the code, and KV for one
edited at runtime by an operator or a panel. Layering both, as above, gets the
useful half of each.

### Wire format version

A stored config document carries a `version`, so a document written by a
different version of jouska is recognised rather than silently reinterpreted:

```json
{
  "version": 1,
  "routes": [{ "id": "core", "match": { "path": "/api" }, "upstream": "api.example.com" }]
}
```

Omitting `version` means 1, so hand-written configs and documents predating
versioning stay valid. A version this build cannot read is rejected — remote
config is discarded and reported via `onRemoteError`, code config throws.
`CONFIG_VERSION` is exported so a control plane can stamp documents it writes.

The version is bumped only for changes an older reader cannot handle; adding an
optional field is backward compatible and does not need one.

An optional `meta` block records who wrote the document and when:

```json
{
  "version": 1,
  "meta": { "updatedAt": "2026-08-26T09:00:00Z", "updatedBy": "panel@example.com", "revision": 7 },
  "routes": [{ "id": "core", "match": { "path": "/api" }, "upstream": "api.example.com" }]
}
```

It is validated for shape and then carried through untouched. No proxying
decision reads it — config that quietly changes behaviour would be a hidden
control surface. It exists so an operator can answer "who changed this and when"
without a separate lookup. On a `byId` merge the remote block is kept, since
code changes are tracked by git rather than by these fields.

### Which store

Match the store to the access pattern rather than putting everything in one
place:

| Data              | Store            | Why                                                                  |
| ----------------- | ---------------- | -------------------------------------------------------------------- |
| Route table       | KV, one JSON key | Read-mostly, whole-document reads, editable as text in the dashboard |
| Audit trail       | D1               | Append-only, queried by time, needs history                          |
| Traffic stats     | Analytics Engine | Write-heavy; does not consume KV or D1 quota                         |
| Panel credentials | Secrets Store    | Injected at deploy, zero runtime reads                               |

Do not put the route table in D1: each request would cost a SQL query, and a
table of N routes costs N row reads per request against the 5M/day free
allowance — it runs out sooner than KV does.

## Guards

Guards run cheapest-first, so a request that will be refused never reaches the
upstream: country and IP checks are local, rate limiting costs one binding call,
access control costs crypto (and, on a cold JWKS, a fetch), forwarding costs a
network round trip.

`cors` accepts `origins`, `allowMethods`, `allowHeaders`, `exposeHeaders`,
`credentials`, and `maxAge`. Omitting `origins` reflects whatever origin the
caller sent, which is what makes credentialed requests work — the spec forbids
`*` alongside `Access-Control-Allow-Credentials`, and browsers reject the whole
response when both appear. Preflights are answered without contacting the
upstream.

### Delegated auth (forwardAuth)

Delegated auth answers "who are you" without a login flow in the library. It
sits after rate limiting but before forwarding, so a refused caller costs no
upstream round trip:

```ts
{
  match: { path: '/admin' },
  upstream: 'app.example.com',

  // Delegated auth (nginx auth_request semantics): one subrequest per call,
  // 2xx admits, any other status is relayed to the caller verbatim.
  forwardAuth: {
    url: 'https://sso.example.com/check',
    // Headers copied to the auth endpoint; default `authorization, cookie`.
    copyRequestHeaders: ['authorization', 'cookie'],
    // Auth verdicts copied into the upstream request.
    copyResponseHeaders: ['x-user-id'],
    timeoutMs: 2000,      // timeout and other network failures fail closed (503)…
    failOpen: true,       // …unless you opt out, which is flagged as high-risk.
  },
}
```

The auth subrequest carries the original method, only the listed request
headers, and no body — the body is a one-shot stream the upstream request still
needs. It is issued with a direct `fetch`, never through the route table, so a
`forwardAuth.url` pointing at a host another route also matches cannot recurse.
Copied response headers go through the same reserved-name refusal as
`requestHeaders`, so a verdict cannot inject the headers jouska derives itself.

A route with delegated auth refuses `cache` at config time: the response is
about the caller, and a shared cache keyed by URL cannot be trusted to tell
callers apart. A route whose auth endpoint is unreachable fails closed with 503
(`{ error: 'forward_auth_unavailable' }`); `failOpen` inverts that, and the
panel flags it as high risk because an outage then becomes open doors.

`rateLimit` needs a `binding` name and an optional `by` strategy:

| `by`           | Bucket                                                               |
| -------------- | -------------------------------------------------------------------- |
| `ip` (default) | Per caller, per route.                                               |
| `path`         | Per caller, per path — one endpoint cannot exhaust another's budget. |
| `route`        | One shared bucket for the whole route.                               |

Declare the binding in your wrangler config:

```jsonc
{
  "ratelimits": [
    { "name": "RL", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } },
  ],
}
```

By default a CORS preflight does not consume budget: a browser issues one per
cross-origin call, so counting both halves the effective limit for exactly the
callers behaving correctly. Set `countPreflight: true` to count them.

Buckets are namespaced by the route's `id` when it has one, and otherwise by a
label derived from what it matches — including its methods, so two routes
differing only by method do not share a budget.

`period` accepts only `10` or `60` seconds — a platform constraint, not a
choice. Counting is per-location rather than globally exact — the documented trade-off
of the native binding, and adequate for abuse control. A missing binding is
reported as a 500 rather than silently admitting traffic.

### Request policy

`requestPolicy` admits only listed methods and caps the body size:

```ts
{
  match: { path: '/api' },
  upstream: 'api.example.com',
  requestPolicy: {
    allowedMethods: ['GET', 'POST'],
    maxBodyBytes: 10 * 1024 * 1024,
  },
}
```

`allowedMethods` and `match.methods` answer different questions, and a route can
carry both. `match.methods` decides whether the route is hit at all: a request
outside it is not matched, falls through to the rest of the app, and is no
concern of this route. `allowedMethods` decides whether a _matched_ request is
forwarded: one outside it is refused with 405 and an `Allow` header naming the
list. The schema refuses a pair with nothing in common — every request the
route could match would be refused, so the block reads as a guard but works as
a full stop. A CORS preflight on a route with `cors` is exempt, since jouska
answers it itself; without `cors` an `OPTIONS` is forwarded and subject to the
list like any other method.

`maxBodyBytes` is enforced twice, because `Content-Length` cannot be trusted
and chunked uploads carry none. A declared length over the limit is refused
with 413 before anything is forwarded. A body that declares nothing — or lies —
is counted while it streams, and the upload is aborted mid-flight once the
count passes the limit; the client receives 413. Bytes already handed to
`fetch` before the cut may have reached the upstream, which is why a declared
size is refused earlier, before anything is sent. Counting only ever delays
bytes through a pass-through transform, so the memory cost is one chunk either
way — the 128MB ceiling is never approached by body size.

### Access control

The other guards answer "where from, how fast". `access` answers "who", with two
mechanisms that both have to pass when both are configured:

```ts
{
  match: { path: '/admin/*' },
  upstream: 'internal.example.com',
  access: {
    cloudflare: { team: 'acme', audience: 'xyz.access', emails: ['ops@example.com'] },
    keys: ['<64-hex SHA-256 of the key>'],
  },
}
```

**Prefer the platform first.** Cloudflare Access can protect an entire hostname
in front of this Worker — identity is then verified before any of this code runs,
costing the request nothing. Route-level `access` is the fallback for the case
where whole-host protection does not fit: one hostname serving both a public
mirror and a private admin path.

**`cloudflare`** verifies the `Cf-Access-Jwt-Assertion` header Cloudflare Access
attaches to requests it has already authenticated. The JWT is checked against the
team's published JWKS (`https://{team}.cloudflareaccess.com/cdn-cgi/access/certs`,
fetched once per isolate and cached for an hour), its signature is verified as
RS256, and only then are its claims read: `exp` and `nbf` must hold, `aud` must
equal `audience`, and when `emails` is set the token's email must be listed. The
`team` name's shape is pinned by the schema, so the JWKS URL can only ever name a
`cloudflareaccess.com` host.

**`keys`** takes SHA-256 hex digests, never raw keys — a leaked config must not
be a key ring. Present the key as `Authorization: Bearer <key>` (or in the header
named by `access.header`, raw). Digested keys are compared in constant time; the
key itself is high-entropy, so the digest needs no salt, matching how the admin
panel stores its own MCP tokens.

Every refusal is final — the request never reaches the upstream — and the status
says which thing failed:

| Status | Meaning                                                               |
| ------ | --------------------------------------------------------------------- |
| `401`  | No usable credential: missing, malformed, expired, wrong key.         |
| `403`  | A valid credential that does not grant this route (`aud`, email).     |
| `503`  | The verification material (JWKS) could not be obtained — fail closed. |

Credentials are length-capped before any parsing or hashing (512 characters for
keys, 4096 for JWTs), because the cap costs one comparison while an oversized
credential is a CPU bill — on the same ordering principle that puts this guard
after rate limiting. Verification runs last among the guards: a request the
geo, IP or rate limiter would refuse never pays for crypto, so an
unauthenticated caller cannot turn the route into a CPU amplifier.

Generate a key and its digest in one line:

```sh
openssl rand -base64 32 | tee /dev/stderr | sha256sum
```

The base64 key on stderr is shown once — hand it to the caller; the hex digest
on stdout goes into `access.keys`.

## Response caching

Off unless a route asks for it. When it does, GET and HEAD responses are stored in
the Cloudflare Cache API, so a mirrored site's stylesheets, scripts and images cost
one edge-to-origin round trip between visitors instead of one each:

```ts
{
  match: { host: 'mirror.example.com' },
  upstream: 'origin.example.com',
  bodyRewrite: {},
  cache: {
    ttlSeconds: 300,
    staleWhileRevalidateSeconds: 60,
    // Defaults shown; `enabled` exists so a tuned block can be switched off
    // without deleting the numbers that took work to arrive at.
    enabled: true,
    methods: ['GET', 'HEAD'],
    contentTypes: ['text/css', 'text/javascript', 'application/javascript', 'image/', 'font/'],
    lockMisses: true,
    staleIfError: { seconds: 3600, on: ['timeout', 'unreachable'] },
    // No default: only 200 responses are cached until status codes are given
    // windows here.
    key: {
      // "all" keeps every query parameter; "none" drops the whole search
      // string; an object names the parameters to ignore or include. Names
      // are case-sensitive — the query is opaque bytes to HTTP.
      query: 'all',
      // Request headers folded into the key. Folding a header also covers a
      // matching upstream `Vary` — see "What is never cached".
      headers: [],
    },
  },
}
```

Query-string noise and per-visitor headers are the two ways a healthy hit rate
dies. `key` exists for both:

```ts
cache: {
  // Twenty campaigns, one cache entry.
  key: { query: { ignore: ['utm_source', 'utm_medium', 'fbclid'] } },
}
```

```ts
cache: {
  // The upstream sends `Vary: accept-language`; folding that header into the
  // key gives each language its own entry instead of refusing the response.
  key: { headers: ['accept-language'] },
}
```

`text/html` is absent from the defaults on purpose. A document is the response most
likely to be personalised, and while the guards below catch the usual signals — a
request carrying `Cookie`, a response carrying `Set-Cookie` or
`Cache-Control: private` — a page personalised without any of them would be served
to the next visitor. Adding a document type is allowed, and flagged in the admin
panel, rather than forbidden: a static site is exactly where caching HTML pays off.

### What is stored, and under what key

**The rewritten bytes, not the upstream's.** Storing the original and re-running
the rewrite on each hit would save the network and spend the CPU, which is the half
Workers bills for:

| Stored form       | Gains                             | Costs                                                    |
| ----------------- | --------------------------------- | -------------------------------------------------------- |
| The original      | A config change needs no eviction | Every hit re-runs `HTMLRewriter`; network saved, CPU not |
| The rewritten one | A hit is served as-is             | An entry is only valid for the config that produced it   |

That cost is paid by the key rather than by eviction. The key carries a fingerprint
of the whole route, so a configuration change simply produces different keys and
the old entries expire unnoticed — nothing has to be enumerated and deleted, which
the Cache API cannot do anyway. The fingerprint hashes the _entire_ route rather
than a curated list of response-affecting fields: a curated list is a standing
invitation to forget one, and a forgotten field means two configurations sharing an
entry, which is serving the wrong bytes. Being wrong the other way costs a cold
cache after an unrelated edit like `timeoutMs`, which nobody notices.

The key is the request URL plus one query parameter, `__jouska_ck`, carrying the
fingerprint, the method, and a hash of the folded `key.headers` values. The query
string in the key is normalised: parameters are filtered by `key.query`, sorted,
and exact duplicates collapsed, and `URLSearchParams` folds encoding spellings for
free (`%61=1` and `a=1` are the same pair, as are `?a` and `?a=`). Parameter names
stay case-sensitive — the query is opaque bytes to HTTP, and an upstream may treat
`Tab` and `tab` differently. Folding `key.headers` compares a missing header with
one present and empty, because collapsing those would hand two upstream-distinct
requests one entry. Three consequences worth knowing: a request whose URL already
contains that parameter is not cached at all (overwriting it would map two
different requests onto one entry), GET and HEAD get separate entries — a HEAD
response has no body, and storing it under the GET key would hand the next GET an
empty one — and changing `key` itself produces a different fingerprint, so old
entries expire rather than alias.

### What is never cached

- A route with delegated auth (`forwardAuth`). This is refused at config time
  rather than filtered at runtime — the response is about the caller, and no URL
  key can tell callers apart.
- A method outside `methods`, or anything but GET and HEAD.
- A request carrying `Authorization` or `Cookie` — its response is probably about
  the person who sent it, and this cache is keyed by URL alone.
- A request carrying `Range`: the answer is either a 206, which the Cache API
  refuses outright, or a 200 the client will slice itself.
- A status given no window. `ttlSeconds` is the 200 window; every other status is
  refused unless `statusTtlSeconds` hands its code a window: `{ 404: 60 }` caches
  404s for a minute so a directory scan repeats at the edge instead of the origin,
  and `{ 200: 0 }` refuses 200s while 404s are cached. An explicit `0` refuses;
  an absent code falls back to `ttlSeconds` for 200 and to nothing for everything
  else. Negative entries are not a second-class cache — but the refusals below
  still veto them, and `contentTypes` does not: that list guards against caching a
  document by accident, and an operator who asked for a 301 window has already
  decided what belongs there.
- A response carrying `Set-Cookie`.
- A response whose `Cache-Control` says `no-store`, `private` or `no-cache`.
  `no-cache` counts because its real meaning is "revalidate before reuse", and a
  rewritten response has no validator to revalidate with.
- A response with a `Vary` this key does not cover. Two ways a `Vary` is covered:
  `accept-encoding`, which is provable rather than hopeful — jouska deletes it
  from every upstream request, so the upstream sees the same absent value every
  time and cannot vary on it — and any header listed in `key.headers`, whose
  request value is folded into the key, so entries for differing values are
  distinct by construction. Everything else is unrepresented, and the platform
  will not make up the difference: verified in workerd, `match` does not honour
  `Vary` at all, which makes this check the only thing standing between a varying
  response and one visitor being served another's. `Vary: *` names no header, so
  nothing can fold it into a key. A Vary refusal reports `miss`, not `bypass` —
  the request could take part; the response could not be stored.
- A 200 response whose content type is outside `contentTypes`, matched as a
  prefix. The list guards 200s only — statuses cached by their own window are
  admitted by that window, with the vetoes above still standing.

Those decisions read the headers the **upstream** sent, not the response as it will
be delivered — so a `responseHeaders.remove` naming `cache-control` or `vary`
deletes the upstream's statement without changing the fact it stated. Only `status`
and `Content-Type` are read from the delivered response, because a content type is
a label an operator may legitimately correct.

An upstream `max-age` is _not_ honoured as a ceiling: `ttlSeconds` is what the
operator decided, and mirrored origins routinely send `max-age=0` for assets that
never change. The refusals above are the upstream's veto; the window is the
operator's. A client's own `Cache-Control` is ignored entirely, since honouring
`no-cache` from a request would let anyone aim the full load at the upstream.

### Freshness, and staleness

Freshness is TTL and nothing else. A body jouska rewrote has no `ETag` or
`Last-Modified` — they are stripped, because keeping them lets a client answer its
own next request with the _unrewritten_ body — so there is nothing to revalidate
against. This is a direct consequence of the rewriting design rather than an
oversight, and the cache is built to admit it.

Past `ttlSeconds` and within `staleWhileRevalidateSeconds`, the stale entry is
served immediately and a refresh runs behind the response, so the visitor who
happened to arrive past the TTL does not pay for the revalidation. A burst of stale
requests triggers one refresh per isolate, not one each, and a refresh that fails
leaves the stale entry in place for the next attempt. Set
`staleWhileRevalidateSeconds: 0` to make that visitor wait for the upstream instead.

The age of an entry is computed from a timestamp jouska stores on it, not from the
platform's `Age` header — verified in workerd, that header reads 0 no matter how
long the entry has been held. The response the client receives carries an accurate
`Age`, which a shared cache owes it, and the upstream's own `Cache-Control`
restored; the lifetime jouska declares on the stored copy covers the stale window
too, because an entry the platform considers expired is invisible to `match` rather
than returned as stale.

### When the upstream is down

`staleIfError` widens the stale window for one situation only: the upstream cannot
answer. Until `ttlSeconds + max(staleWhileRevalidateSeconds, staleIfError.seconds)`
after the entry was stored, a failure whose mode is listed in `staleIfError.on` —
`timeout` and `unreachable` by default, `5xx` opt-in — delivers the stale entry
with `x-jouska-cache: stale_error` and an accurate `Age`, and the failure itself
surfaces only past that widened window. The modes `on` counts are chosen narrowly
on purpose: an upstream 404 is an _answer_, albeit a negative one, and covering it
with a stale 200 would be lying with the cache's help. A connection that never
completes is not an answer, and covering it with the last good copy is what the
cache is for. `5xx` needs opting in because a maintenance page served stale is a
choice, not a default; a client hang-up counts never, because nobody is left to
serve.

### When a cold cache meets a burst

The other gap is the first minute of a deployment: a cold cache turns every URL
into a miss, and a hundred simultaneous requests for the same stylesheet are a
hundred upstream trips — the load spike the cache exists to prevent. `lockMisses`
(on by default) closes it per isolate: the first miss leads, fetching and storing
alone, while the rest wait for the entry to land and then re-read the cache and
serve it. A waiter's wait is bounded by the route's `totalTimeoutMs`, and a waiter
whose wait ran out — or whose leader's fill produced nothing cacheable — falls
through and fetches on its own, exactly as it would have without the lock. The
lock is per isolate, not a distributed one: two isolates can both lead, so the
upstream sees one request per isolate rather than one per visitor.

### Seeing whether it works

Every response from a caching route carries `x-jouska-cache`, and every `onProxy`
event carries the same value on `event.cache`:

| Value         | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `hit`         | Served from a fresh entry. No upstream trip; `attempts` is 0.                   |
| `stale`       | Served from an expired entry, with a refresh running behind the response.       |
| `miss`        | Eligible, no entry there, so the upstream was asked.                            |
| `bypass`      | Never a candidate — the method, or credentials in the request.                  |
| `stale_error` | Served from an expired entry because the upstream failed within `staleIfError`. |

`bypass` and `miss` are distinguished because tuning a hit rate needs them apart:
one says the cache was not allowed to help, the other that it was and could not.
`stale_error` is distinguished from `stale` because it says the entry is past its
useful life and being kept alive by failure — a cache absorbing an outage reads
very differently on a dashboard from a cache riding its grace period, and the
`attempts` on such an event shows the failed upstream trip it absorbed.

A hit also reports `rewriteSkipped: 'served_from_cache'` when the route configures
`bodyRewrite`, so the rewrite rate does not read as broken once caching is on. See
Observability for why that reason exists.

The store defaults to `caches.default` and can be replaced with the `cacheImpl`
option, which takes anything with `match` and `put`. A failed write is swallowed —
it must not be able to fail a response that already succeeded — so the symptom of a
store that keeps refusing, an object over the size limit most likely, is a hit rate
of zero rather than an error.

Cache API rather than KV, deliberately: a KV read per request is the cost the config
cache exists to avoid, and paying it back here would spend the saving twice.

## Observability

`onProxy` is called once per proxied request, after the response is decided:

```ts
app.use(
  '*',
  jouska({
    config,
    onProxy: (event) => {
      // Analytics Engine writes are I/O, so do not hold the response for them.
      c.executionCtx.waitUntil(
        Promise.resolve(
          env.STATS.writeDataPoint({
            blobs: [event.routeId, event.upstream, event.outcome],
            doubles: [event.status, event.durationMs, event.attempts],
            indexes: [event.routeId],
          }),
        ),
      );
    },
  }),
);
```

| Field        | Meaning                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routeId`    | The matched route, labelled the way rate-limit buckets are.                                                                                                                                                                                                                                                                                             |
| `upstream`   | Authority the request was sent to. Empty on an edge answer — there is no upstream to blame.                                                                                                                                                                                                                                                             |
| `method`     | Request method.                                                                                                                                                                                                                                                                                                                                         |
| `path`       | Path as the client wrote it, before normalisation.                                                                                                                                                                                                                                                                                                      |
| `status`     | Status returned to the client, including jouska's own 4xx and 5xx.                                                                                                                                                                                                                                                                                      |
| `durationMs` | Wall-clock milliseconds from match to response.                                                                                                                                                                                                                                                                                                         |
| `attempts`   | Upstream attempts, including the first — so a retry is visible.                                                                                                                                                                                                                                                                                         |
| `outcome`    | `ok`, `refused`, `timeout`, `unreachable`, `client_closed`, or `responded` — an edge answer from a `respond` route, which produced a response without one upstream attempt.                                                                                                                                                                             |
| `cache`      | `hit`, `stale`, `miss`, `bypass` or `stale_error`; absent without a `cache` block.                                                                                                                                                                                                                                                                      |
| `selection`  | How a split route picked its upstream — present only on `trafficSplit` routes, with the winning entry's `index`, whether a `sticky` cookie or the `weighted` hash decided, and the `scope` the weighted hash was taken over: `ip` (the default and any fallback), `path`, `url`, `header`, `cookie`, `query`, or `none` when there was nothing to hash. |
| `ejected`    | Candidates the outlier memory removed from the walk before the first attempt. Absent when nothing was skipped, and on routes without an `outlier` policy.                                                                                                                                                                                               |
| `stream`     | Promise of how the body stream ended, resolved once it has. Absent when nothing streamed from an upstream — a refusal, a 101, a bodyless response, a cache hit.                                                                                                                                                                                         |

Three more report what happened to the response body, which is what a mirrored
site is judged by:

| Field               | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `bodyRewritten`     | True when the body was handed to the rewriter.                           |
| `rewriteSkipped`    | Why it was not. Absent when it was, and when nothing was proxied.        |
| `redirectRewritten` | True when the `Location` sent to the client differs from the upstream's. |

`rewriteSkipped` names one of seven causes. Every one of them used to be silent,
and that silence is the problem: a mirror whose links still point at the origin
renders identically to one whose links were rewritten, until a visitor clicks one
and leaves.

| Value                 | Cause                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `not_configured`      | The route has no `bodyRewrite` at all.                                           |
| `bodyless_status`     | 204, 206 or 304 — the status forbids a body.                                     |
| `no_body`             | The status permits a body and none arrived, as for the answer to a HEAD.         |
| `content_type`        | The type is outside `bodyRewrite.contentTypes`.                                  |
| `streaming_media`     | A stream, refused whatever `contentTypes` says; see Streaming media.             |
| `charset_undecodable` | A declared charset this runtime cannot decode, with no usable `fallbackCharset`. |
| `served_from_cache`   | The response came from the route's cache, so no rewrite ran on this request.     |

`charset_undecodable` is the one worth alerting on: the config reads correctly,
the page renders, and the links simply do not change.

`stream` resolves to `{ outcome, bytes, durationMs }`, where `outcome` is
`complete`, `first_chunk_timeout`, `idle_timeout`, `upstream_reset` or
`client_closed`. It is a promise rather than a second callback so that the event
itself is not delayed: waiting for the body would hold every `waitUntil` the host
queued from `onProxy` until the client had finished reading, which on a streamed
answer is minutes. A host that wants the outcome awaits it inside
`ctx.waitUntil`; one that does not ignores it. It never rejects.

The two deadline outcomes are the ones to alert on: they mean the proxy cut a
response the client had already been told was `200 OK`, which is unrecoverable by
construction — the headers are gone — and invisible in `status`.

`served_from_cache` keeps a caching route's rewrite rate readable: without it every
hit would report `bodyRewritten: false` with nothing to tell that apart from a
rewrite nobody configured. It is reported only when the route _does_ configure
`bodyRewrite` — a route that does not keeps saying `not_configured`, so "which
routes forgot to turn rewriting on" stays answerable through a cache. The bytes in
an entry were rewritten when it was stored; the key carries a fingerprint of the
configuration that did it, so an entry cannot outlive the config it belongs to.

All three are known, and reported, before the body is streamed. `bodyRewritten`
therefore states that the transform was installed rather than that it finished:
waiting for it to drain would hold the event — and any `waitUntil` queued from it —
until the client had already read the response.

The event carries no URLs beyond `path`. Reporting the address before and after
rewriting would put whatever a query string held, tokens included, into every log
line; a boolean and an enum answer the question without that.

A callback rather than a binding, deliberately: writing to Analytics Engine, a
log line, or nothing at all is a deployment decision. A library that picked one
would either pull in a binding nobody asked for or invent a config surface for
something the host already has. Errors thrown from it are swallowed —
observability must not be able to fail a request.

A guard refusal is reported with `attempts: 0`, so the share of traffic turned
away before costing a round trip is visible without inferring it.

### Reference receivers

The reference Worker (`workers/reverse-proxy`) makes that decision once so you
don't have to. Both receivers live in one file, `observability.ts`, are optional
and deletable, and are a no-op when nothing is configured:

- **Analytics Engine** — bind `ANALYTICS` and every proxied request writes one
  data point: `routeId` as the index, blobs `[upstream, method, outcome, cache]`,
  doubles `[status, durationMs, attempts]`. Per-route latency percentiles,
  4xx/5xx and timeout rates, and the response-cache hit rate are then plain SQL
  over the dataset:

  ```sql
  SELECT index AS route_id,
    quantile(0.5)(double2) AS p50, quantile(0.95)(double2) AS p95,
    quantile(0.99)(double2) AS p99,
    countIf(double1 >= 400) / count() AS error_rate,
    countIf(blob3 = 'timeout') / count() AS timeout_rate,
    countIf(blob4 = 'hit') / countIf(blob4 != '') AS cache_hit_rate
  FROM jouska
  WHERE timestamp > NOW() - INTERVAL '1' HOUR
  GROUP BY route_id
  ```

  `cache` is the fourth blob rather than an inserted one, so a query written
  against the previous three-blob layout keeps returning the same columns. It is
  the empty string on a route without caching, which is what separates "not
  caching" from a `bypass` the cache decided on.

- **Workers Logs** — set `ACCESS_LOGS: "true"` (the reference config does) and
  every proxied request emits one structured JSON line via `console.info`,
  which Workers Logs collects because the deployment has `observability`
  enabled.

Two properties the receivers guarantee, because the library's contract forces
them. `onProxy` throws are swallowed, so each receiver catches its own errors:
the failing receiver reports once and disables itself, degrading to silence
rather than failing requests or logging per hit. And cardinality is bounded:
Analytics Engine groups only by `routeId`, never `path` — a mirror site serving
arbitrary URLs would otherwise grow dimensions without limit — while the log
line carries a truncated `path` (Workers Logs caps and samples lines, a metrics
dimension cannot be un-capped). Neither receiver holds the response:
`writeDataPoint` and `console.*` are synchronous and buffered by the runtime;
a receiver that does real async I/O is the one that needs `ctx.waitUntil`.

## Errors

| Status | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| 403    | Refused by `blockCountries`, `allowCountries`, or an `ip` rule. |
| 403    | A per-caller rate limit with no identifiable caller.            |
| 405    | Method outside `requestPolicy.allowedMethods`; carries `Allow`. |
| 413    | Body over `requestPolicy.maxBodyBytes`.                         |
| 429    | Rate limit exceeded.                                            |
| 499    | The client hung up before the upstream answered.                |
| 500    | The `rateLimit` binding named in config is missing.             |
| 502    | Upstream unreachable after all attempts.                        |
| 504    | Upstream sent no headers within `timeoutMs` / `totalTimeoutMs`. |

An `errorPages` entry for 502 or 504 replaces the payload and the headers of the
matching row above, never its status: the upstream is still as broken as the
status says, and a page must not make a failure read as success.

499 is nginx's non-standard "client closed request". Nothing is listening for it,
but it keeps client aborts out of the upstream error rate, where they would look
like the origin failing.

A body deadline has no status. By the time `firstChunkTimeoutMs` or
`streamIdleTimeoutMs` expires the headers have shipped, so the client's stream
errors mid-flight and the status stays whatever the upstream sent — usually 200.
`ProxyEvent.stream` is where that shows up; see Streaming deadlines.

A missing rate-limit binding is a 500 rather than an open door, and a per-caller
limit that cannot be keyed is a 403. One shared `unknown` bucket would either let
a single client exhaust everyone's budget or let an attacker evade the limit by
suppressing whatever identifies them.

## Platform constraints this design respects

These are Workers limits, not choices, and they shape the architecture:

- **6 outbound connections per request.** One request resolves to exactly one
  upstream. Failover is strictly sequential and a weighted split sends each
  request to one winner, so racing or fanning out across upstreams is not
  expressible here. A delegated-auth subrequest takes one of the six itself;
  it runs before the upstream attempt, so a guarded route spends its budget on
  the auth round trip first and the connection count still holds.
- **128MB memory, on every plan.** Body rewriting is streaming throughout;
  nothing calls `await response.text()` on a proxied body.
- **Wall time is not bounded, CPU time is.** An HTTP-triggered Worker has no
  duration limit — "as long as the client remains connected, the Worker can
  continue processing, making subrequests, and streaming a response body" — and
  "there is no set time limit on individual subrequests". Waiting on an upstream
  spends no CPU, which is why the body deadlines above bound silence rather than
  duration. What is bounded is CPU (10ms free, 30s–5min paid) and, during a
  platform update, in-flight requests get a 30-second grace period — so a stream
  running for many minutes may be terminated by a deploy, whatever this proxy
  does.
- **The Cache API keys on GET and does not honour `Vary`.** `put` throws on a
  non-GET key, on a 206 and on `Vary: *`; it accepts and then silently drops a
  304, a 5xx, a `Set-Cookie` response and anything marked `private`, `no-store`
  or `no-cache`; and it stores a 404 quite happily. It also returns an entry
  stored with `Vary: cookie` to a request carrying a different cookie. Response
  caching therefore decides every one of those itself rather than leaning on the
  platform — all verified in workerd.
- **No `least_conn` on a split.** Least-connections needs a shared count of
  in-flight requests, which on Workers means a Durable Object round trip on
  every proxied request — a latency and cost floor the routing layer exists to
  avoid. A per-isolate count without that round trip is not a fallback either:
  it would see only the requests that isolate happened to receive and read
  counts that are wrong by whole isolates, while promising by its name to do
  what it cannot. A split is hash-assigned for exactly that reason —
  deterministic from the request alone, no shared state — and the honest
  alternatives to that are recorded here rather than behind a flag that
  overstates itself.

## Admin panel

`workers/admin-panel` is the operator UI for the remote route table: a Hono API
and a no-build vanilla SPA deployed as one Worker with static assets. It
supports multiple users out of the box, and stays inside the free tier (D1 for
users, sessions and the audit log; one KV key for the published document).

### Sign-in

Two doors, and they are not equal.

**Cloudflare Access, preferred.** Set `ACCESS_TEAM` and `ACCESS_AUD` and the
platform authenticates every request before this Worker runs. There is no
password to store and no hash to budget CPU for, and adding a login method —
Cloudflare's own identity provider, a one-time email PIN, GitHub, Google, Okta,
generic OIDC, generic SAML — is a change in the Zero Trust dashboard rather than
a change in this repository. Hardware keys are Access's per-application MFA, not
a plugin here.

The panel reads the identity from `Cf-Access-Jwt-Assertion` and verifies it with
the same `verifyAccessJwt` the proxy's route-level `access` guard is built on —
one verifier, two callers, for the same reason the panel validates with the
proxy's own `configSchema`. It deliberately does _not_ rely on `ctx.access`: a
Worker with static assets runs behind an internal router that never populates
it, which is measured on a real deployment rather than inferred, and
`run_worker_first` does not change it. Under `wrangler dev` the opposite holds —
an `access.dev` block populates the context and no header exists — so both are
accepted, header first.

The first caller Access vouches for becomes the initial admin. Everyone after
that has to already be in `users`: an Access policy is routinely written wider
than the panel's intent (a whole email domain, a whole Cloudflare account), and
creating a row for anyone who passes the door would hand the route table to a
group nobody enumerated. `role` and `disabled` stay in D1 rather than moving to
Access groups, because the last-admin guard is only enforceable where it is
evaluated atomically at write time.

Both variables or neither. A team name without an audience proves a token was
signed by the right organisation but not that it was issued for _this_
application, and any other app in the same team could then admit a caller.

**Password, the older door.** Without those two variables the panel
authenticates itself: the first caller to `/api/auth/bootstrap` becomes the
initial admin, sessions live in D1 as SHA-256 digests of a 32-byte cookie token,
five consecutive failures park an account for 15 minutes, and a lost password is
recovered out of band through a one-time token an operator writes into
`settings`.

The two coexist so a deployment can migrate without a flag day, and the order
between them is load-bearing: a credential that was _presented_ and failed is
refused outright, and only an absent one falls through to the cookie. Otherwise
a bad token could shop for a second opinion, and turning Access off would be
something an attacker does per request instead of something the operator does in
the dashboard. An unobtainable JWKS answers `503`, never `401` — without
verification material there is no safe way to say yes.

### MCP access

An admin issues machine tokens on the 「MCP 令牌」screen — admin-only, because a
token is a standing grant rather than a session. Tokens look like `jska_mcp_…`
and the database keeps only their SHA-256 digest, so the secret appears exactly
once, in the response that creates it; a lost token is revoked and reissued,
never recovered. Every token carries a fixed expiry, 365 days at most, and can
be revoked at any time.

MCP answers on `/mcp`, same origin as the panel, authenticated by
`Authorization: Bearer <token>` and nothing else — the Cookie session and its
same-origin rules do not apply there, and a browser cookie cannot stand in for a
token. Scopes are granted per token:

- **`config:read`** — the draft, the defaults, and preview output.
- **`config:write`** — edits the draft. It does not publish.
- **`domains:read`** — hostnames bound to the proxy.
- **`audit:read`** — the audit log.

There is no publish scope, by construction. An agent can rewrite the draft, run
the preview and report the dangerous switches it found, but moving that draft
into production traffic still goes through an admin at the existing publish
confirmation. And what an agent did stays attributable: writes are recorded
against `mcp:<token-id>:<user>`, so revoking a token does not erase the trail of
what it touched.

The endpoint speaks protocol revision `2026-07-28` and only that one. That
revision has no `initialize` handshake: every request carries its version in
both the `MCP-Protocol-Version` header and the `_meta` envelope, and mirrors its
method and tool name into `Mcp-Method` / `Mcp-Name`, which the server checks
against the body — a header and a body that disagree are two different requests
to whatever sits in between, so they are refused rather than reconciled. A
client that opens with `initialize` is answered with the version list instead,
which is the only diagnostic a handshake-era client can show its user. `GET` and
`DELETE` answer `405` (the revision removed the GET stream and sessions), a body
that is not `application/json` answers `415`, and one over 256 kB answers `413`
while it is still arriving.

Adding it to a client is one command, because the token is passed as a header
rather than negotiated — there is no OAuth discovery document here:

```sh
claude mcp add --transport http jouska https://panel.example.com/mcp \
  --header "Authorization: Bearer jska_mcp_…"
```

### Deploy

The committed `wrangler.jsonc` files are account-agnostic templates — D1 and
KV ids differ per Cloudflare account, so the repo ships placeholders and one
command wires in the real ones. Find-or-create D1 `jouska-admin` and KV
`CONFIG_KV`, patch both Workers' configs, idempotent on re-run:

```sh
npx wrangler login
npm run cf:setup
```

The CI `Deploy` workflow (on `v*` tags) runs the same provisioning step before
migrating and deploying the panel, then the proxy — first deploy creates the
resources, later deploys reuse them. Only the two Cloudflare secrets
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are needed; the patched ids
live on the ephemeral runner, never in git. D1 migrations run first, then the
Worker, then a `/api/health` probe must answer `{"ok":true}` on the deployed
workers.dev URL before the job passes. Local development works against local
simulators without any of this:

```sh
npx wrangler d1 migrations apply jouska-admin --local -c workers/admin-panel/wrangler.jsonc
npx wrangler dev -c workers/admin-panel/wrangler.jsonc
```

### Hostname discovery

The 「域名」screen answers the question an operator has while writing
`match.host`: which hostnames actually arrive at the proxy? That fact lives in
the Cloudflare account, so the panel reads it from there — three sources, in
ascending order of cost:

| Source         | Calls | What it yields                                   |
| -------------- | ----- | ------------------------------------------------ |
| workers.dev    | 2     | `<script>.<subdomain>.workers.dev`, when enabled |
| Custom Domains | 1     | exact hostnames, filtered to the proxy's script  |
| Zone routes    | 1 + N | route _patterns_, N = zones examined (capped)    |

Route patterns are not hostnames — `*.example.com/*` is a pattern, and the
screen labels it as one rather than presenting it as somewhere you can browse.
The screen also cross-references both directions: a bound hostname no route
claims, and an enabled route whose `match.host` matches nothing bound.

Two settings, `CF_ACCOUNT_ID` and `CF_API_TOKEN`, both optional. The CI deploy
job wires both from the secrets it already has, so a tag deploy needs nothing
extra. Neither is ever written to a tracked file: the account id is injected at
deploy time with `--var`, and the token is set as a Worker secret from stdin.

Permissions, when reusing the deploy token (what CI does): Cloudflare's Edit
permissions include Read, so the token's existing `Workers Scripts Edit` covers
workers.dev and Custom Domains, and `Workers Routes Edit` covers the zone route
query — both verified against the live API. Enumerating the account's zones
additionally needs `Zone Read`, which a deploy has no reason to carry, so it is
the one permission to add for this feature. Any source that cannot be read is
reported as unreadable with the permission named, while the others answer
normally.

Reusing the deploy token has a cost worth stating: it carries write scopes, so a
compromised panel yields a credential that can reconfigure Workers, KV and D1
rather than one that can only list hostnames. A separate token with just
`Workers Scripts Read` (+ `Zone Read` and `Workers Routes Read`) removes that
exposure at the price of a second secret to maintain:

```sh
npx wrangler secret put CF_API_TOKEN -c workers/admin-panel/wrangler.jsonc
```

Either way the panel never writes through the token and never returns it.

Without the credentials the screen explains what to set; it does not error, and
no other screen is affected. Sources fail independently, so a token with
`Workers Scripts Read` alone still answers two of the three questions and says
so about the third. Zones beyond the per-request budget are named rather than
silently dropped, so "no routes found" is never confused with "did not look".

Discovery is a read: it writes nothing to D1, KV or the audit log, and answers
are cached in isolate memory for 60 seconds so a burst of screen-opens costs one
round of API calls. Any signed-in user can read it — hostnames are public by
construction, being what the proxy answers on.

Why not detect it from the proxy itself: Cloudflare's edge validates the `Host`
header against the _certificate's_ scope, not against the Worker's bound
hostname. Verified against the edge, `x.<script>.<subdomain>.workers.dev`
reaches a Worker bound only at `<script>.<subdomain>.workers.dev`, and with a
zone's default `*.example.com` certificate every sibling subdomain passes the
same check. A Worker that reported the hostnames it saw would therefore report
hostnames it is not bound to, including any an attacker chose — the opposite of
what a screen for authoring `match.host` should show.

### Architecture notes

- **Publish is the only KV write.** Editing routes or defaults only changes
  D1; preview compiles the full document and reports issues, shadowed routes,
  whole-site routes that will not rewrite their links, and dangerous switches
  before anything reaches the proxy. Publishing with dangerous switches requires
  an explicit `confirm`.
- **The proxy keeps winning merges.** The panel writes the same document shape
  `resolveConfig` reads, so `merge: 'byId'` with a code table continues to
  work: code wins ties, git stays the reviewable fallback.
- **Sessions are D1 rows, not JWTs.** Revocation is instant (logout deletes the
  row), passwords are PBKDF2 with 30k iterations — sized for the Workers CPU
  budget, verified by a timing test — and login locks after five consecutive
  failures.
- **CSRF is a server-side same-origin check** on every mutation; the SPA is
  same-origin by construction and needs no tokens.

## Development

```sh
npm run check   # lint + format + typecheck + tests + build
npm test        # tests only
npm run build   # emit dist/
npm run format  # apply formatting
```

CI runs that same `npm run check`, so there is no gate that passes locally but
fails upstream.

Publishing is deliberately blocked: `scripts.prepublishOnly` exits non-zero
because the package name is not final. Note that `"private": true` would not be
enough on its own — npm only honours it inside workspaces. When publishing is
turned on, replace that script with `npm run check` so a release cannot ship
something CI would reject.

Tests run inside `workerd`, the same runtime Cloudflare runs in production, via
`@cloudflare/vitest-pool-workers`. Integration tests proxy to a controlled
in-process upstream rather than the public network, so they are deterministic
and exercise the real `HTMLRewriter`, streams, and `AbortSignal`.

## Prior art

Route-table design informed by [reflare](https://github.com/latticehr/reflare)
and Proxyflare, both unmaintained. jouska shares no code with either.

## License

MIT

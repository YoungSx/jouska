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

| Concern                                         | Where it lives            |
| ----------------------------------------------- | ------------------------- |
| Route table matching (host, path, method)       | `src/router.ts`           |
| Header forwarding, deadlines, bounded retries   | `src/internal/forward.ts` |
| `Location` / `Set-Cookie` / validator rewriting | `src/internal/headers.ts` |
| Streaming body rewriting                        | `src/internal/body.ts`    |
| Geo, IP and rate-limit guards                   | `src/internal/guards.ts`  |
| Config schema, normalisation and validation     | `src/config.ts`           |

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

| Option                 | Default  | Meaning                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `id`                   | —        | Stable handle. Used for `byId` merges and rate-limit buckets.         |
| `match.host`           | —        | Host to match. `*.example.com` matches subdomains, not the apex.      |
| `match.path`           | —        | Path prefix, matched on segment boundaries.                           |
| `match.methods`        | all      | Restrict the route to specific methods.                               |
| `upstream`             | required | `host`, `host:port` or `host/base/path`. No scheme.                   |
| `scheme`               | `https`  | Scheme used to reach the upstream.                                    |
| `allowPrivateUpstream` | off      | Permit a loopback, private or metadata upstream.                      |
| `stripPrefix`          | `false`  | Remove the matched prefix before forwarding.                          |
| `timeoutMs`            | `10000`  | Per-attempt upstream deadline.                                        |
| `totalTimeoutMs`       | `30000`  | Ceiling on all attempts combined, including backoff.                  |
| `retries`              | `0`      | Extra attempts. Only idempotent methods retry.                        |
| `retryBackoffMs`       | `100`    | Delay before the first retry, doubled for each subsequent one.        |
| `rewriteHeaders`       | `true`   | Rewrite `Location`, `Refresh` and `Set-Cookie` onto the proxy.        |
| `manualRedirect`       | `true`   | Ask for the redirect instead of following it upstream.                |
| `websocket`            | `true`   | Forward WebSocket upgrades.                                           |
| `bodyRewrite`          | off      | Streaming body rewriting; see below.                                  |
| `blockCountries`       | `[]`     | ISO 3166-1 alpha-2 codes refused with 403.                            |
| `allowCountries`       | —        | When set, only these are admitted. Fails closed on an unknown origin. |
| `upstreamHeaders`      | `{}`     | Headers injected into the upstream request.                           |
| `cors`                 | off      | CORS handling; see Guards.                                            |
| `ip`                   | off      | IP allow/deny rules; see Guards.                                      |
| `rateLimit`            | off      | Rate limiting via the native binding; see Guards.                     |

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

`upstreamHeaders` fills gaps entry by entry, because it is a bag of independent
headers rather than one setting: a route adding a header of its own keeps the
table-wide ones, and on a name collision the route still wins. The policy blocks
—`cors`, `ip`, `rateLimit`, `bodyRewrite`—are replaced whole instead, since
merging halves of two of them would produce a policy neither the table nor the
route wrote.

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
passed through. `upstreamHeaders` may not set any of these four — the config is
rejected rather than silently ignored.

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

### Retries and deadlines

Retries replay only **network failures and timeouts**. An HTTP 5xx is a normal
response and is returned as-is on the first attempt: replaying it would pile
load onto a struggling origin for no expected benefit. A client that hangs up is
not retried either — nobody is waiting — and cancels the upstream request rather
than leaving it to run out its deadline.

Attempts back off exponentially from `retryBackoffMs`, and `totalTimeoutMs`
bounds them all together. Without that ceiling, `retries: 3` with
`timeoutMs: 30000` could occupy the proxy for two minutes before returning 504.

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
forwarding costs a network round trip.

`cors` accepts `origins`, `allowMethods`, `allowHeaders`, `exposeHeaders`,
`credentials`, and `maxAge`. Omitting `origins` reflects whatever origin the
caller sent, which is what makes credentialed requests work — the spec forbids
`*` alongside `Access-Control-Allow-Credentials`, and browsers reject the whole
response when both appear. Preflights are answered without contacting the
upstream.

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

| Field        | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `routeId`    | The matched route, labelled the way rate-limit buckets are.        |
| `upstream`   | Authority the request was sent to.                                 |
| `method`     | Request method.                                                    |
| `path`       | Path as the client wrote it, before normalisation.                 |
| `status`     | Status returned to the client, including jouska's own 4xx and 5xx. |
| `durationMs` | Wall-clock milliseconds from match to response.                    |
| `attempts`   | Upstream attempts, including the first — so a retry is visible.    |
| `outcome`    | `ok`, `refused`, `timeout`, `unreachable`, or `client_closed`.     |

Three more report what happened to the response body, which is what a mirrored
site is judged by:

| Field               | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `bodyRewritten`     | True when the body was handed to the rewriter.                           |
| `rewriteSkipped`    | Why it was not. Absent when it was, and when nothing was proxied.        |
| `redirectRewritten` | True when the `Location` sent to the client differs from the upstream's. |

`rewriteSkipped` names one of five causes. Every one of them used to be silent,
and that silence is the problem: a mirror whose links still point at the origin
renders identically to one whose links were rewritten, until a visitor clicks one
and leaves.

| Value                 | Cause                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `not_configured`      | The route has no `bodyRewrite` at all.                                           |
| `bodyless_status`     | 204, 206 or 304 — the status forbids a body.                                     |
| `no_body`             | The status permits a body and none arrived, as for the answer to a HEAD.         |
| `content_type`        | The type is outside `bodyRewrite.contentTypes`.                                  |
| `charset_undecodable` | A declared charset this runtime cannot decode, with no usable `fallbackCharset`. |

`charset_undecodable` is the one worth alerting on: the config reads correctly,
the page renders, and the links simply do not change.

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
  data point: `routeId` as the index, blobs `[upstream, method, outcome]`,
  doubles `[status, durationMs, attempts]`. Per-route latency percentiles,
  4xx/5xx and timeout rates are then plain SQL over the dataset:

  ```sql
  SELECT index AS route_id,
    quantile(0.5)(double2) AS p50, quantile(0.95)(double2) AS p95,
    quantile(0.99)(double2) AS p99,
    countIf(double1 >= 400) / count() AS error_rate,
    countIf(blob3 = 'timeout') / count() AS timeout_rate
  FROM jouska
  WHERE timestamp > NOW() - INTERVAL '1' HOUR
  GROUP BY route_id
  ```

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
| 429    | Rate limit exceeded.                                            |
| 499    | The client hung up before the upstream answered.                |
| 500    | The `rateLimit` binding named in config is missing.             |
| 502    | Upstream unreachable after all attempts.                        |
| 504    | Upstream exceeded `timeoutMs` or `totalTimeoutMs`.              |

499 is nginx's non-standard "client closed request". Nothing is listening for it,
but it keeps client aborts out of the upstream error rate, where they would look
like the origin failing.

A missing rate-limit binding is a 500 rather than an open door, and a per-caller
limit that cannot be keyed is a 403. One shared `unknown` bucket would either let
a single client exhaust everyone's budget or let an attacker evade the limit by
suppressing whatever identifies them.

## Platform constraints this design respects

These are Workers limits, not choices, and they shape the architecture:

- **6 outbound connections per request.** One request resolves to exactly one
  upstream, so racing or fanning out across upstreams is not expressible.
- **128MB memory, on every plan.** Body rewriting is streaming throughout;
  nothing calls `await response.text()` on a proxied body.
- **CPU time limits.** `timeoutMs` is capped at 30s to stay inside them.

## Admin panel

`workers/admin-panel` is the operator UI for the remote route table: a Hono API
and a no-build vanilla SPA deployed as one Worker with static assets. It
supports multiple users out of the box — the first caller to `/api/auth/bootstrap`
becomes the initial admin, further users are created by an admin — and stays
inside the free tier (D1 for sessions, users and the audit log; one KV key for
the published document).

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
  D1; preview compiles the full document and reports issues, shadowed routes
  and dangerous switches before anything reaches the proxy. Publishing with
  dangerous switches requires an explicit `confirm`.
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

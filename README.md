# veilo

Reverse-proxy middleware for [Hono](https://hono.dev) on Cloudflare Workers.

A declarative route table maps incoming requests to upstreams, and the response
is rewritten so the visitor never leaves the proxy: redirects, cookies, and
in-page links all point back at your own hostname.

## Why a middleware, not a framework

Routing and middleware pipelines are solved problems, so veilo does not
reimplement them — it plugs into Hono. Likewise, request forwarding builds on
`hono/proxy`, which already handles hop-by-hop header stripping, `duplex: 'half'`
for streamed bodies, and dropping `accept-encoding` so upstream bodies arrive
uncompressed.

What veilo adds is everything `hono/proxy` deliberately leaves out:

| Concern                                   | Where it lives            |
| ----------------------------------------- | ------------------------- |
| Route table matching (host, path, method) | `src/router.ts`           |
| Upstream deadlines and bounded retries    | `src/internal/forward.ts` |
| `Location` / `Set-Cookie` rewriting       | `src/internal/headers.ts` |
| Streaming body rewriting                  | `src/internal/body.ts`    |
| Config schema and validation              | `src/config.ts`           |

## Install

```sh
npm i veilo hono
```

`hono` is a peer dependency, so your app controls its version.

## Usage

```ts
import { Hono } from 'hono';
import { defineConfig, veilo } from 'veilo';

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
app.use('*', veilo({ config }));

// Unmatched requests fall through, so your own handlers still work.
app.get('/health', (c) => c.text('ok'));

export default app;
```

Routes are evaluated in order and the first match wins.

## Route options

| Option            | Default  | Meaning                                                          |
| ----------------- | -------- | ---------------------------------------------------------------- |
| `match.host`      | —        | Host to match. `*.example.com` matches subdomains, not the apex. |
| `match.path`      | —        | Path prefix, matched on segment boundaries.                      |
| `match.methods`   | all      | Restrict the route to specific methods.                          |
| `upstream`        | required | `host` or `host/base/path`. No scheme.                           |
| `stripPrefix`     | `false`  | Remove the matched prefix before forwarding.                     |
| `timeoutMs`       | `10000`  | Per-attempt upstream deadline.                                   |
| `retries`         | `0`      | Extra attempts. Only idempotent methods retry.                   |
| `rewriteHeaders`  | `true`   | Rewrite `Location` and `Set-Cookie` onto the proxy.              |
| `bodyRewrite`     | off      | Streaming body rewriting; see below.                             |
| `blockCountries`  | `[]`     | ISO 3166-1 alpha-2 codes refused with 403.                       |
| `upstreamHeaders` | `{}`     | Headers injected into the upstream request.                      |

`bodyRewrite` accepts `rewriteLinks` (default `true`), `contentTypes`
(default `['text/html']`), and `replace` (literal `from`/`to` pairs). HTML goes
through the native `HTMLRewriter`, which rewrites URL-bearing attributes and
leaves text nodes alone; other allowed text types go through a streaming
replacer that handles matches straddling chunk boundaries.

Replacements are applied in a single pass, so rules never cascade into one
another: `{a→b, b→c}` will not turn `a` into `c`.

## Config precedence

A route table can be written in code or stored remotely (KV, D1, an admin
panel). `resolveConfig` combines them, and **code always wins**:

```ts
import { resolveConfig, veilo } from 'veilo';

export default {
  async fetch(request, env) {
    const config = resolveConfig({
      code: { routes: [{ id: 'core', match: { path: '/api' }, upstream: 'api.example.com' }] },
      remote: await env.CONFIG.get('routes', 'json'),
      merge: 'byId',
      onRemoteError: (error) => console.error('remote config rejected', error),
    });
    const app = new Hono();
    app.use('*', veilo({ config }));
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
import { createConfigCache, resolveConfig, veilo } from 'veilo';
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
    app.use('*', veilo({ config: await cache.get() }));
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

The staleness this introduces is bounded by `ttlMs`. KV is eventually consistent
regardless, so a write already takes time to propagate; the TTL makes that
existing delay explicit rather than adding a new one.

### Wire format version

A stored config document carries a `version`, so a document written by a
different version of veilo is recognised rather than silently reinterpreted:

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

`period` accepts only `10` or `60` seconds — a platform constraint, not a
choice. Counting is per-location rather than globally exact — the documented trade-off
of the native binding, and adequate for abuse control. A missing binding is
reported as a 500 rather than silently admitting traffic.

## Errors

| Status | Meaning                                  |
| ------ | ---------------------------------------- |
| 403    | Request origin is in `blockCountries`.   |
| 502    | Upstream unreachable after all attempts. |
| 504    | Upstream exceeded `timeoutMs`.           |

## Platform constraints this design respects

These are Workers limits, not choices, and they shape the architecture:

- **6 outbound connections per request.** One request resolves to exactly one
  upstream, so racing or fanning out across upstreams is not expressible.
- **128MB memory, on every plan.** Body rewriting is streaming throughout;
  nothing calls `await response.text()` on a proxied body.
- **CPU time limits.** `timeoutMs` is capped at 30s to stay inside them.

## Development

```sh
npm run check   # lint + format + typecheck + tests + build
npm test        # tests only
npm run build   # emit dist/
npm run format  # apply formatting
```

CI runs that same `npm run check`, so there is no gate that passes locally but
fails upstream.

Tests run inside `workerd`, the same runtime Cloudflare runs in production, via
`@cloudflare/vitest-pool-workers`. Integration tests proxy to a controlled
in-process upstream rather than the public network, so they are deterministic
and exercise the real `HTMLRewriter`, streams, and `AbortSignal`.

## Prior art

Route-table design informed by [reflare](https://github.com/latticehr/reflare)
and Proxyflare, both unmaintained. veilo shares no code with either.

## License

MIT

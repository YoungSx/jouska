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

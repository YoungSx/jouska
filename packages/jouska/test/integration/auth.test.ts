import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';

/**
 * Delegated authentication (forwardAuth) — the guard that answers "who are you"
 * by asking a URL, in the nginx `auth_request` shape.
 *
 * The assertions follow the #53 acceptance list and, as everywhere else in this
 * suite, check what the client and the upstream actually received — not what
 * the middleware thinks it did.
 */

/** One stub answering every outbound call: the auth endpoint and upstreams. */
const appWith = (
  routes: ConfigInput['routes'],
  fetchImpl: typeof fetch,
  events: ProxyEvent[] = [],
): Hono => {
  const app = new Hono();
  app.use(
    '*',
    jouska({ config: defineConfig({ routes }), fetchImpl, onProxy: (e) => events.push(e) }),
  );
  return app;
};

/** An auth endpoint that says yes and records nothing. */
const authOk = (headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 200, headers });

const auth401 = (): Response =>
  new Response('denied', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="sso"' },
  });

/** Route that delegates to auth.test, plus a stub that handles it. */
const forwardAuthRoute = (overrides: Record<string, unknown> = {}): ConfigInput['routes'][number] => ({
  match: { path: '/a' },
  upstream: 'o.test',
  forwardAuth: {
    url: 'https://auth.test/check',
    copyResponseHeaders: ['x-user-id'],
    ...(overrides as object),
  },
});

/** Dispatches by host: auth.test answers with `auth`, everything else is upstream. */
const stubFetch =
  (
    auth: (req: Request) => Response | Promise<Response>,
    upstream: (req: Request) => Response | Promise<Response> = () => new Response('ok'),
  ) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (new URL(req.url).host === 'auth.test') {
      return auth(req);
    }
    return upstream(req);
  };

/** A spy fetch that never answers, but honours an already-aborted signal. */
const neverResponds: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  if (request.signal.aborted) {
    throw request.signal.reason;
  }
  return new Promise<Response>((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });
};

describe('forwardAuth', () => {
  it('copies the named response headers into the upstream request', async () => {
    const requests: Request[] = [];
    const app = appWith(
      [forwardAuthRoute()],
      stubFetch(
        () => authOk({ 'x-user-id': 'u1' }),
        (req) => {
          requests.push(req);
          return new Response('from upstream');
        },
      ),
    );
    const res = await app.request('https://p.dev/a', {
      headers: { cookie: 'session=abc' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from upstream');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('x-user-id')).toBe('u1');
  });

  it('sends the copied request headers and its own forwarding headers to the auth endpoint', async () => {
    let authRequest: Request | undefined;
    const app = appWith(
      [forwardAuthRoute()],
      stubFetch((req) => {
        authRequest = req;
        return authOk();
      }),
    );
    await app.request('https://p.dev/a?x=1', {
      headers: { cookie: 'session=abc', authorization: 'Bearer t', 'x-client': 'mine' },
    });
    expect(authRequest).toBeDefined();
    expect(authRequest!.url).toBe('https://auth.test/check');
    expect(authRequest!.headers.get('cookie')).toBe('session=abc');
    expect(authRequest!.headers.get('authorization')).toBe('Bearer t');
    expect(authRequest!.headers.get('x-client')).toBeNull();
    expect(authRequest!.headers.get('x-forwarded-host')).toBe('p.dev');
    expect(authRequest!.headers.get('x-forwarded-uri')).toBe('/a?x=1');
  });

  it('relays a non-2xx verdict verbatim and never reaches the upstream', async () => {
    let upstreamCalls = 0;
    const app = appWith(
      [forwardAuthRoute()],
      stubFetch(
        () => auth401(),
        () => {
          upstreamCalls += 1;
          return new Response('ok');
        },
      ),
    );
    const res = await app.request('https://p.dev/a');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('denied');
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="sso"');
    expect(upstreamCalls).toBe(0);
  });

  it('answers 503 when the auth endpoint times out, failing closed', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [forwardAuthRoute({ timeoutMs: 50 })],
      neverResponds,
      events,
    );
    const res = await app.request('https://p.dev/a');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'forward_auth_unavailable' });
    expect(events[0]!.outcome).toBe('refused');
    expect(events[0]!.attempts).toBe(0);
  });

  it('admits the request when the auth endpoint times out and the route opted into failOpen', async () => {
    const app = appWith(
      [forwardAuthRoute({ timeoutMs: 50, failOpen: true })],
      stubFetch(() => Promise.reject(new Error('unreachable')), () => new Response('from upstream')),
    );
    const res = await app.request('https://p.dev/a');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from upstream');
  });

  it('does not recurse when the auth url shares a host with another route', async () => {
    const requests: Request[] = [];
    const app = appWith(
      [
        forwardAuthRoute(),
        { match: { path: '/b' }, upstream: 'auth.test' },
      ],
      async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        requests.push(req);
        return new URL(req.url).host === 'auth.test' ? authOk() : new Response('ok');
      },
    );
    const res = await app.request('https://p.dev/a');
    expect(res.status).toBe(200);
    // Exactly one auth exchange and one upstream call — the direct fetch never
    // walks the route table, so the second route cannot multiply it.
    expect(requests.map((r) => new URL(r.url).host)).toEqual(['auth.test', 'o.test']);
  });
});

describe('access control and the guard chain', () => {
  it('skips auth on a CORS preflight and answers locally', async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response('ok');
    };
    const app = appWith([
      {
        match: { path: '/a' },
        upstream: 'o.test',
        cors: { allowMethods: ['POST'] },
        forwardAuth: { url: 'https://auth.test/check' },
      },
    ], fetchImpl);
    const res = await app.request(new Request('https://p.dev/a', {
      method: 'OPTIONS',
      headers: { origin: 'https://client.test', 'access-control-request-method': 'POST' },
    }));
    expect(res.status).toBe(204);
    expect(fetchCalls).toBe(0);
  });

  it('reports the auth stage duration and zero attempts on refusal', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [forwardAuthRoute()],
      stubFetch(() => auth401()),
      events,
    );
    const refused = await app.request('https://p.dev/a');
    expect(refused.status).toBe(401);
    expect(events[0]!.attempts).toBe(0);
    expect(events[0]!.outcome).toBe('refused');
    expect(typeof events[0]!.authDurationMs).toBe('number');
  });
});

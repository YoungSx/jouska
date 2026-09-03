import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';
import { CACHE_STATE_HEADER, type ResponseCacheStore } from '../../src/internal/response-cache';
import { resetLimitsLedgers } from '../../src/internal/limits';

// The fuses are module-scope state that outlives one app instance — that is
// their whole point — so every test here starts from empty ledgers.
beforeEach(() => {
  resetLimitsLedgers();
});

/**
 * An upstream that never answers, but honours the abort signal the way a real
 * fetch does — so the per-attempt deadline genuinely fires rather than being
 * merely outlasted, and a client hang-up reaches the attempt as an abort.
 */
const neverResponds: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.signal.aborted) {
    throw request.signal.reason;
  }
  return new Promise<Response>((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });
};

/**
 * An upstream that hangs until released, and can be switched to answering.
 * `seated(n)` resolves once the upstream has been called `n` times; waiters sit
 * in a list re-checked on every call, so a waiter works whether it was
 * registered before or after the calls it waits for.
 */
const hangable = () => {
  const resolvers: Array<(response: Response) => void> = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let calls = 0;
  const settle = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (calls >= waiters[i]!.n) {
        waiters.splice(i, 1)[0]!.resolve();
      }
    }
  };
  const seated = (n: number): Promise<void> => {
    if (calls >= n) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push({ n, resolve });
    });
  };
  let normal = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    settle();
    if (normal) {
      // A content type the default cacheable list admits — it names static
      // assets, and text/html is deliberately absent — so a route with caching
      // actually stores what this upstream returns.
      return new Response('from upstream', { headers: { 'content-type': 'text/css' } });
    }
    const request = input instanceof Request ? input : new Request(input, init);
    return new Promise<Response>((resolve, reject) => {
      resolvers.push(resolve);
      request.signal.addEventListener('abort', () => reject(request.signal.reason));
    });
  };
  return {
    fetchImpl,
    /** Resolves once the upstream has been called `n` times. */
    seated,
    releaseAll: () => {
      for (const resolve of resolvers.splice(0)) {
        resolve(new Response('late'));
      }
    },
    answerNormally: () => {
      normal = true;
    },
    /** Puts the upstream back to hanging after `answerNormally`. */
    suspend: () => {
      normal = false;
    },
    calls: () => calls,
  };
};

const appWith = (
  routes: ConfigInput['routes'],
  fetchImpl: typeof fetch,
  events: ProxyEvent[] = [],
) => {
  const app = new Hono();
  app.use(
    '*',
    jouska({ config: defineConfig({ routes }), fetchImpl, onProxy: (e) => events.push(e) }),
  );
  return app;
};

const route = (extra: Record<string, unknown>): ConfigInput['routes'] => [
  { match: { path: '/x' }, upstream: 'o.test', ...extra } as ConfigInput['routes'][number],
];

/**
 * Issues a request with a real `ExecutionContext`, as the cache tests do: Hono
 * throws `This context has no ExecutionContext` from a bare `app.request()`
 * once the middleware schedules a cache write.
 */
const fetchWith = async (app: Hono, path: string): Promise<Response> => {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => scheduled.push(work),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const response = await app.fetch(new Request(`https://p.dev${path}`), {}, ctx);
  const body = await response.arrayBuffer();
  await Promise.all(scheduled);
  return new Response(body, { status: response.status, headers: response.headers });
};

const memoryStore = (): ResponseCacheStore => {
  const entries = new Map<
    string,
    { status: number; headers: [string, string][]; body: ArrayBuffer }
  >();
  return {
    match: async (key) => {
      const hit = entries.get(key.url);
      return hit === undefined
        ? undefined
        : new Response(hit.body, { status: hit.status, headers: hit.headers });
    },
    put: async (key, response) => {
      entries.set(key.url, {
        status: response.status,
        headers: [...response.headers],
        body: await response.arrayBuffer(),
      });
    },
  };
};

describe('retry budget', () => {
  /**
   * The upstream never answers, so every attempt costs its `timeoutMs`. Without
   * the budget, `retries: 5` means six attempts per request — six fifty-millisecond
   * stalls per caller, unbounded across callers. With a 0.2 budget the first walk
   * spends its one permitted retry and every walk after it is refused its extras.
   *
   * The counts are read back to back, inside the same couple-of-seconds window:
   * a gap of two buckets or more between the requests would legitimately forget
   * them, which is the recovery the window exists to provide.
   */
  it('caps the attempts a timing-out route performs as a whole', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      route({
        retries: 5,
        retryBackoffMs: 0,
        timeoutMs: 50,
        limits: { retryRatio: 0.2 },
      }),
      neverResponds,
      events,
    );
    const first = await app.request('https://p.dev/x');
    const second = await app.request('https://p.dev/x');
    const third = await app.request('https://p.dev/x');

    for (const res of [first, second, third]) {
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({ error: 'upstream_timeout', upstream: 'o.test' });
    }
    // 6 per request without the budget; 4 with it. The first walk is allowed one
    // retry — the budget counts retries performed, and it had performed none —
    // then spends it on itself and is refused from there on.
    expect(events.map((e) => e.attempts)).toEqual([2, 1, 1]);
    // Every walk that was cut short says so; nothing is indistinguishable from
    // a route configured with `retries: 0`.
    for (const event of events) {
      expect(event.limitReason).toBe('retry_budget');
    }
  });

  it('never reports a limit reason when nothing was held back', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      route({ limits: { retryRatio: 0.2 } }),
      () => Promise.resolve(new Response('ok')),
      events,
    );
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(200);
    expect(events[0]!.attempts).toBe(1);
    // Absent, not false: a healthy request on a limited route reads exactly as
    // it did before the block existed.
    expect('limitReason' in events[0]!).toBe(false);
  });

  it('counts failover to a fresh candidate as a first attempt, not a retry', () => {
    // A route that walks A → B performs no retries at all, so a zero budget
    // must not clip the walk it takes to reach the healthy candidate.
    const events: ProxyEvent[] = [];
    let hits = 0;
    const fetchImpl: typeof fetch = async (input) => {
      hits += 1;
      if (new URL(input instanceof Request ? input.url : String(input)).host === 'a.test') {
        throw new Error('down');
      }
      return new Response('ok');
    };
    const app = appWith(
      [
        {
          match: { path: '/x' },
          upstreams: ['a.test', 'b.test'],
          limits: { retryRatio: 0 },
        },
      ],
      fetchImpl,
      events,
    );
    return (async () => {
      const first = await app.request('https://p.dev/x');
      const second = await app.request('https://p.dev/x');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(hits).toBe(4);
      for (const event of events) {
        expect(event.attempts).toBe(2);
        expect('limitReason' in event).toBe(false);
      }
    })();
  });
});

describe('in-flight fuse', () => {
  it('refuses at once when full, and admits again once a seat frees', async () => {
    const events: ProxyEvent[] = [];
    const up = hangable();
    const app = appWith(route({ limits: { maxInFlight: 2 } }), up.fetchImpl, events);

    const first = app.request('https://p.dev/x');
    const second = app.request('https://p.dev/x');
    await up.seated(2);

    // Refused without waiting: the two seats are still held, so anything other
    // than an immediate 503 would be the fuse queueing, which it must not do.
    const third = await app.request('https://p.dev/x');
    expect(third.status).toBe(503);
    expect(await third.json()).toEqual({ error: 'in_flight_limit', upstream: 'o.test' });
    const refused = events.find((e) => e.status === 503)!;
    expect(refused.outcome).toBe('refused');
    expect(refused.attempts).toBe(0);
    expect(refused.limitReason).toBe('in_flight');
    expect(refused.upstream).toBe('o.test');
    // Every response jouska builds itself carries the request ID — this 503 is
    // no exception — so the response in the client's hand matches the `refused`
    // line in the log, the same invariant the other guards are held to.
    expect(third.headers.get('x-request-id')).not.toBeNull();
    expect(third.headers.get('x-request-id')).toBe(refused.requestId);

    up.releaseAll();
    expect(await first).toMatchObject({ status: 200 });
    expect(await second).toMatchObject({ status: 200 });

    // The released seats are really back: a fresh request is forwarded, not
    // refused. The waiter goes in before the request does, so the call count
    // cannot pass it by.
    const fourthSeated = up.seated(up.calls() + 1);
    const fourth = app.request('https://p.dev/x');
    await fourthSeated;
    up.releaseAll();
    expect(await fourth).toMatchObject({ status: 200 });
  });

  it('releases the seat when the client hangs up, every time', async () => {
    const events: ProxyEvent[] = [];
    const up = hangable();
    const app = appWith(route({ limits: { maxInFlight: 1 } }), up.fetchImpl, events);

    // Five callers in a row hang up mid-request. A seat leaked on any one of
    // them would fuse the route shut from that point on.
    for (let i = 0; i < 5; i += 1) {
      const controller = new AbortController();
      const pending = app.fetch(new Request('https://p.dev/x', { signal: controller.signal }));
      await up.seated(i + 1);
      controller.abort();
      const res = await pending;
      expect(res.status).toBe(499);
      expect(events.at(-1)!.outcome).toBe('client_closed');
      expect(events.at(-1)!.attempts).toBe(1);
    }

    // The seat is still there to take.
    up.answerNormally();
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from upstream');
    expect(events.at(-1)!.attempts).toBe(1);
  });

  it('releases the seat on a deadline and on an unreachable upstream', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      route({ retries: 0, timeoutMs: 50, limits: { maxInFlight: 1 } }),
      neverResponds,
      events,
    );
    const timedOut = await app.request('https://p.dev/x');
    expect(timedOut.status).toBe(504);
    expect(events[0]!.attempts).toBe(1);

    // 504 again, not 503: the seat the timed-out walk held came back.
    const again = await app.request('https://p.dev/x');
    expect(again.status).toBe(504);
    expect(events[1]!.attempts).toBe(1);
  });

  it('releases the seat when the walk throws', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      route({ retries: 0, limits: { maxInFlight: 1 } }),
      () => Promise.reject(new Error('connection reset')),
      events,
    );
    const failed = await app.request('https://p.dev/x');
    expect(failed.status).toBe(502);
    expect(events[0]!.attempts).toBe(1);

    // 502 again, not 503: the seat came back through the throw.
    const again = await app.request('https://p.dev/x');
    expect(again.status).toBe(502);
    expect(events[1]!.attempts).toBe(1);
  });

  it('serves a cache hit even when the fuse is full', async () => {
    const events: ProxyEvent[] = [];
    const up = hangable();
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [
            {
              match: { path: '/' },
              upstream: 'o.test',
              cache: { ttlSeconds: 300 },
              limits: { maxInFlight: 1 },
            },
          ],
        }),
        fetchImpl: up.fetchImpl,
        cacheImpl: memoryStore(),
        onProxy: (e) => events.push(e),
      }),
    );

    // Fill the cache while the upstream is answering; a hanging upstream would
    // leave the fill itself incomplete. The route's default `contentTypes` list
    // admits only HTML, so the upstream returns HTML or nothing is stored.
    up.answerNormally();
    const filled = await fetchWith(app, '/a');
    expect(filled.headers.get(CACHE_STATE_HEADER)).toBe('miss');

    // The one seat is now held by a request to another path.
    up.suspend();
    const controller = new AbortController();
    const pending = app.fetch(new Request('https://p.dev/b', { signal: controller.signal }));
    await up.seated(up.calls() + 1);

    // A hit never touches the upstream, so it never takes a seat — and a
    // saturated origin must not turn it into a 503.
    const hit = await fetchWith(app, '/a');
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe('from upstream');
    expect(hit.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect('limitReason' in events.at(-1)!).toBe(false);

    controller.abort();
    await pending;
  });
});

describe('limits config schema', () => {
  const limitsRoute = (limits: Record<string, unknown>): ConfigInput['routes'] => [
    { match: { path: '/x' }, upstream: 'o.test', limits } as ConfigInput['routes'][number],
  ];

  it('rejects a retryRatio outside zero to one', () => {
    expect(() => defineConfig({ routes: limitsRoute({ retryRatio: 1.5 }) })).toThrow();
    expect(() => defineConfig({ routes: limitsRoute({ retryRatio: -0.1 }) })).toThrow();
  });

  it('rejects a maxInFlight below one, fractional, or past the ceiling', () => {
    expect(() => defineConfig({ routes: limitsRoute({ maxInFlight: 0 }) })).toThrow();
    expect(() => defineConfig({ routes: limitsRoute({ maxInFlight: 2.5 }) })).toThrow();
    expect(() => defineConfig({ routes: limitsRoute({ maxInFlight: 10_001 }) })).toThrow();
  });

  it('accepts the boundaries', () => {
    expect(() =>
      defineConfig({ routes: limitsRoute({ retryRatio: 0, maxInFlight: 1 }) }),
    ).not.toThrow();
    expect(() =>
      defineConfig({ routes: limitsRoute({ retryRatio: 1, maxInFlight: 10_000 }) }),
    ).not.toThrow();
  });

  it('leaves a route without limits alone', () => {
    expect(() => defineConfig({ routes: limitsRoute({}) })).not.toThrow();
  });
});

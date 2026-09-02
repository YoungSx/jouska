import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';

/**
 * A scripted upstream: each handler receives the attempted request and answers
 * or throws. Answers are keyed by which candidate was tried, keyed by host, so
 * one `fetchImpl` can stand in for every upstream in a walk at once.
 */
type Script = (req: Request, attempt: number) => Response | Promise<Response>;

const appWith = (
  routes: ConfigInput['routes'],
  script: Script,
  events: ProxyEvent[] = [],
): { app: Hono; requests: Request[] } => {
  const requests: Request[] = [];
  let attempt = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    attempt += 1;
    const req = new Request(input, init);
    requests.push(req);
    const answer = await script(req, attempt);
    return answer instanceof Response ? answer : Promise.reject(answer);
  };
  const app = new Hono();
  app.use(
    '*',
    jouska({ config: defineConfig({ routes }), fetchImpl, onProxy: (e) => events.push(e) }),
  );
  return { app, requests };
};

const ok = (body: string): Response => new Response(body);

describe('failover over an upstream list', () => {
  it('walks to the first candidate that answers', async () => {
    const { app, requests } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'b.test', 'c.test'] }],
      (req) => (req.url.startsWith('https://a.test/') ? new Error('down') : ok('from b')),
    );
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from b');
    expect(requests.map((r) => new URL(r.url).host)).toEqual(['a.test', 'b.test']);
  });

  it('stops at the primary when it is healthy', async () => {
    const { app, requests } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'b.test'] }],
      () => ok('from a'),
    );
    const res = await app.request('https://p.dev/x');
    expect(await res.text()).toBe('from a');
    expect(requests).toHaveLength(1);
  });

  it('builds outbound headers per candidate, so Host names who it hit', async () => {
    const { app, requests } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'b.test'] }],
      (req) => (req.headers.get('host') === 'a.test' ? new Error('down') : ok('b')),
    );
    await app.request('https://p.dev/x');
    // The second attempt must not announce a.test's Host to b.test.
    expect(requests[1]!.headers.get('host')).toBe('b.test');
  });

  it('caps the walk at failover.maxAttempts', async () => {
    const { app, requests } = appWith(
      [
        {
          match: { path: '/x' },
          upstreams: ['a.test', 'b.test', 'c.test'],
          failover: { on: ['timeout', 'unreachable'], maxAttempts: 2 },
        },
      ],
      () => new Error('down'),
    );
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(502);
    expect(requests).toHaveLength(2);
  });

  it('reports the last candidate actually tried when the walk exhausts', async () => {
    const { app } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'b.test'] }],
      () => new Error('down'),
    );
    const res = await app.request('https://p.dev/x');
    expect(await res.json()).toEqual({ error: 'upstream_unreachable', upstream: 'b.test' });
  });

  it('never switches on a condition the policy does not name', async () => {
    const { app, requests } = appWith(
      [
        {
          match: { path: '/x' },
          upstreams: ['a.test', 'b.test'],
          failover: { on: ['timeout'], maxAttempts: 2 },
        },
      ],
      () => new Error('connection refused'),
    );
    const res = await app.request('https://p.dev/x');
    // A generic error is 'unreachable', which this policy does not list.
    expect(res.status).toBe(502);
    expect(requests).toHaveLength(1);
  });

  it('does not switch for a non-replayable request', async () => {
    const { app, requests } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'b.test'] }],
      () => new Error('down'),
    );
    await app.request('https://p.dev/x', { method: 'POST', body: 'data' });
    expect(requests).toHaveLength(1);
  });

  it('returns a 5xx from the primary untouched without 5xx in the policy', async () => {
    const { app, requests } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'b.test'] }],
      () => new Response('v1 error', { status: 503 }),
    );
    const res = await app.request('https://p.dev/x');
    // A 5xx is a normal response and ends the walk by default.
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('v1 error');
    expect(requests).toHaveLength(1);
  });

  it('switches on 5xx when the policy opts in, keeping the last verdict', async () => {
    const { app } = appWith(
      [
        {
          match: { path: '/x' },
          upstreams: ['a.test', 'b.test'],
          failover: { on: ['5xx'], maxAttempts: 2 },
        },
      ],
      (req) =>
        new Response(`${new URL(req.url).host} is broken`, {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const res = await app.request('https://p.dev/x');
    // Every candidate 5xx'd: the walk ends returning the LAST one, body and all
    // — the real upstream verdict, not an invented 502.
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('b.test is broken');
  });

  it('still walks past an opted-in 5xx to a healthy candidate', async () => {
    const { app, requests } = appWith(
      [
        {
          match: { path: '/x' },
          upstreams: ['a.test', 'b.test'],
          failover: { on: ['5xx'], maxAttempts: 2 },
        },
      ],
      (req) =>
        req.url.startsWith('https://a.test/') ? new Response('down', { status: 502 }) : ok('b'),
    );
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('b');
    expect(requests.map((r) => new URL(r.url).host)).toEqual(['a.test', 'b.test']);
  });

  it('retries the same upstream when the list names it twice', async () => {
    let hits = 0;
    const { app } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'a.test', 'b.test'] }],
      () => {
        hits += 1;
        return hits <= 2 ? new Error('down') : ok('third time lucky');
      },
    );
    const res = await app.request('https://p.dev/x');
    // Same-host adjacent attempts are how a failover list spells a same-upstream retry.
    expect(await res.text()).toBe('third time lucky');
  });
});

describe('weighted traffic split', () => {
  const splitRoute = (sticky: boolean): ConfigInput['routes'][number] => ({
    match: { path: '/x' },
    trafficSplit: [
      { upstream: 'a.test', weight: 3 },
      { upstream: 'b.test', weight: 1 },
    ],
    ...(sticky ? { stickyBy: 'cookie' } : {}),
  });

  it('assigns deterministically from the client IP', async () => {
    // Same IP, same bucket — two fresh apps, one host. A second request through
    // a *new* app instance proves the assignment comes from the request alone,
    // not from any state the first call left behind.
    const hosts: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { app, requests } = appWith([splitRoute(false)], () => ok('ok'));
      await app.request('https://p.dev/x', {
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      });
      hosts.push(new URL(requests[0]!.url).host);
    }
    expect(hosts[0]).toBe(hosts[1]);
  });

  it('sends callers with no IP to one stable bucket', async () => {
    const hosts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { app, requests } = appWith([splitRoute(false)], () => ok('ok'));
      await app.request('https://p.dev/x');
      hosts.push(new URL(requests[0]!.url).host);
    }
    // No randomness: every IP-less request lands in the same bucket.
    expect(new Set(hosts).size).toBe(1);
  });

  it('does not set a stickiness cookie without stickyBy', async () => {
    const { app } = appWith([splitRoute(false)], () => ok('ok'));
    const res = await app.request('https://p.dev/x', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sets a host-only stickiness cookie for a newly assigned caller', async () => {
    const { app, requests } = appWith([splitRoute(true)], () => ok('ok'));
    const res = await app.request('https://p.dev/x', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__jouska_upstream=(a\.test|b\.test); /);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
    // The cookie names the upstream that actually answered.
    expect(new URL(requests[0]!.url).host).toBe(cookie.match(/=(\S+?);/)?.[1]);
  });

  it('returns a caller presenting a valid sticky cookie to that upstream', async () => {
    const { app, requests } = appWith([splitRoute(true)], () => ok('ok'));
    await app.request('https://p.dev/x', {
      headers: { cookie: '__jouska_upstream=b.test' },
    });
    expect(new URL(requests[0]!.url).host).toBe('b.test');
  });

  it('re-assigns a stale sticky cookie and sets a fresh one', async () => {
    const { app, requests } = appWith([splitRoute(true)], () => ok('ok'));
    const res = await app.request('https://p.dev/x', {
      headers: { cookie: '__jouska_upstream=retired.test' },
    });
    // Not re-drawn blindly back to a dead name: a new assignment is made.
    expect(res.headers.get('set-cookie')).toMatch(/^__jouska_upstream=/);
    expect(new Set(['a.test', 'b.test'])).toContain(new URL(requests[0]!.url).host);
  });

  it('fails over from the split winner to the other participants', async () => {
    const { app, requests } = appWith([splitRoute(false)], (req) =>
      new URL(req.url).host === 'a.test' ? new Error('down') : ok('from b'),
    );
    const res = await app.request('https://p.dev/x', {
      headers: { cookie: '__jouska_upstream=a.test' },
    });
    // The sticky winner failed; the walk continues into the rest of the split
    // in declared order.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from b');
    expect(requests.map((r) => new URL(r.url).host)).toEqual(['a.test', 'b.test']);
  });
});

describe('onProxy attribution across candidates', () => {
  it('credits the upstream that answered, not the one the walk started from', async () => {
    const events: ProxyEvent[] = [];
    const { app } = appWith(
      [{ match: { path: '/x' }, upstreams: ['a.test', 'b.test'] }],
      (req) => (new URL(req.url).host === 'a.test' ? new Error('down') : ok('b')),
      events,
    );
    await app.request('https://p.dev/x');
    expect(events).toHaveLength(1);
    expect(events[0]!.upstream).toBe('b.test');
    expect(events[0]!.attempts).toBe(2);
    // A fixed-upstream list has nothing to explain, so no selection is emitted.
    expect(events[0]!.selection).toBeUndefined();
  });

  it('explains a split pick with a selection', async () => {
    const events: ProxyEvent[] = [];
    const { app } = appWith(
      [
        {
          match: { path: '/x' },
          trafficSplit: [
            { upstream: 'a.test', weight: 1 },
            { upstream: 'b.test', weight: 1 },
          ],
        },
      ],
      () => ok('ok'),
      events,
    );
    await app.request('https://p.dev/x', { headers: { cookie: '__jouska_upstream=b.test' } });
    expect(events[0]!.selection).toEqual({ index: 1, reason: 'sticky', scope: 'none' });
    expect(events[0]!.upstream).toBe('b.test');
  });
});

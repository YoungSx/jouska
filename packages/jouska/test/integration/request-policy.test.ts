import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';

/**
 * An upstream that reads the whole body before answering — what a real origin
 * does with a POST. On overflow the counting wrapper errors the stream mid-read,
 * which surfaces here as a rejected read; a real upstream would have received
 * whatever was pumped before the cut.
 */
const drainAndAnswer: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  try {
    await req.arrayBuffer();
  } catch {
    // Partial body is the expected shape of an overflow; answer anyway so the
    // test exercises the flag jouska set, not the upstream's verdict.
  }
  return new Response('upstream reached');
};

const appWith = (routes: ConfigInput['routes'], fetchImpl: typeof fetch = drainAndAnswer) => {
  const events: ProxyEvent[] = [];
  const app = new Hono();
  app.use(
    '*',
    jouska({ config: defineConfig({ routes }), fetchImpl, onProxy: (e) => events.push(e) }),
  );
  return { app, events };
};

describe('requestPolicy.allowedMethods', () => {
  it('refuses an unlisted method with 405 and an Allow header', async () => {
    const { app } = appWith([
      { match: { path: '/x' }, upstream: 'o.test', requestPolicy: { allowedMethods: ['GET'] } },
    ]);
    const res = await app.request('https://p.dev/x', { method: 'POST', body: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(await res.json()).toEqual({ error: 'method_not_allowed', allow: ['GET'] });
  });

  it('forwards a listed method', async () => {
    const { app } = appWith([
      { match: { path: '/x' }, upstream: 'o.test', requestPolicy: { allowedMethods: ['POST'] } },
    ]);
    const res = await app.request('https://p.dev/x', { method: 'POST', body: 'x' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream reached');
  });

  it('reports the refusal as an outcome=refused event with zero attempts', async () => {
    const { app, events } = appWith([
      { match: { path: '/x' }, upstream: 'o.test', requestPolicy: { allowedMethods: ['GET'] } },
    ]);
    await app.request('https://p.dev/x', { method: 'DELETE' });
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(405);
    expect(events[0]!.outcome).toBe('refused');
    expect(events[0]!.attempts).toBe(0);
    expect(events[0]!.upstream).toBe('o.test');
  });

  it('applies the list to OPTIONS too when the route has no cors', async () => {
    const { app } = appWith([
      { match: { path: '/x' }, upstream: 'o.test', requestPolicy: { allowedMethods: ['GET'] } },
    ]);
    const res = await app.request('https://p.dev/x', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.test' },
    });
    expect(res.status).toBe(405);
  });

  it('exempts a preflight on a route that answers it itself', async () => {
    // jouska answers this preflight without the upstream; refusing it with 405
    // would break every cross-origin call to a method the route does allow.
    const { app } = appWith([
      {
        match: { path: '/x' },
        upstream: 'o.test',
        requestPolicy: { allowedMethods: ['POST'] },
        cors: { allowMethods: ['POST'] },
      },
    ]);
    const res = await app.request('https://p.dev/x', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.test', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
  });

  it('refuses only after the route matches, leaving match.methods as the gate', async () => {
    // match.methods=false means the route is not hit at all — the request falls
    // through to the rest of the app, it is not a 405 from this route.
    const { app } = appWith([
      {
        match: { path: '/x', methods: ['POST'] },
        upstream: 'o.test',
        requestPolicy: { allowedMethods: ['POST', 'PUT'] },
      },
    ]);
    const res = await app.request('https://p.dev/x', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(404);
  });

  it('refuses a method that match.methods lets in but the list does not', async () => {
    const { app, events } = appWith([
      {
        match: { path: '/x', methods: ['POST', 'PUT'] },
        upstream: 'o.test',
        requestPolicy: { allowedMethods: ['POST'] },
      },
    ]);
    const res = await app.request('https://p.dev/x', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(events[0]!.outcome).toBe('refused');
  });
});

describe('requestPolicy.maxBodyBytes', () => {
  it('refuses a declared Content-Length over the limit before any fetch', async () => {
    let calls = 0;
    const counting: typeof fetch = async () => {
      calls += 1;
      return new Response('should not happen');
    };
    const { app, events } = appWith(
      [
        {
          match: { path: '/x' },
          upstream: 'o.test',
          requestPolicy: { maxBodyBytes: 100 },
        },
      ],
      counting,
    );
    // A body-less POST carrying only the header: the declaration is what the
    // guard acts on, and this keeps the test free of runtime header rewriting.
    const res = await app.request('https://p.dev/x', {
      method: 'POST',
      headers: { 'content-length': '101' },
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('allow')).toBeNull();
    expect(await res.json()).toEqual({ error: 'payload_too_large', maxBodyBytes: 100 });
    expect(calls).toBe(0);
    expect(events[0]!.status).toBe(413);
    expect(events[0]!.outcome).toBe('refused');
  });

  it('passes a declared Content-Length at or under the limit', async () => {
    const { app } = appWith([
      { match: { path: '/x' }, upstream: 'o.test', requestPolicy: { maxBodyBytes: 100 } },
    ]);
    const res = await app.request('https://p.dev/x', {
      method: 'POST',
      headers: { 'content-length': '100' },
    });
    expect(res.status).toBe(200);
  });

  it('counts a chunked body on the stream and refuses past the limit', async () => {
    // No Content-Length: the early check has nothing to read, so this is the
    // only path that can catch it — count while forwarding, cut mid-flight.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123456'));
        controller.enqueue(new TextEncoder().encode('789012'));
        controller.close();
      },
    });
    const { app, events } = appWith([
      { match: { path: '/x' }, upstream: 'o.test', requestPolicy: { maxBodyBytes: 10 } },
    ]);
    const res = await app.request(
      new Request('https://p.dev/x', {
        method: 'POST',
        body,
        // RequestInit in the workers types omits `duplex`, which a stream body needs.
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large', maxBodyBytes: 10 });
    expect(events[0]!.status).toBe(413);
    expect(events[0]!.outcome).toBe('refused');
  });

  it('streams a chunked body under the limit through untouched', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345'));
        controller.close();
      },
    });
    const { app } = appWith([
      { match: { path: '/x' }, upstream: 'o.test', requestPolicy: { maxBodyBytes: 10 } },
    ]);
    const res = await app.request(
      new Request('https://p.dev/x', { method: 'POST', body, duplex: 'half' } as RequestInit),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream reached');
  });

  it('refuses a limit reached after the upstream already answered', async () => {
    // A runtime sends the body while awaiting the response, and honours the
    // abort that jouska fires when the counter trips — so an upstream that
    // answered without reading the whole body still ends in jouska's 413, not
    // the upstream's 200.
    const answerWhileSending: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      try {
        await req.arrayBuffer();
      } catch {
        // The upload was cut mid-flight; fall through to the signal check.
      }
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response('accepted');
    };
    const endlessBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('1234567890'));
      },
    });
    const { app } = appWith(
      [{ match: { path: '/x' }, upstream: 'o.test', requestPolicy: { maxBodyBytes: 10 } }],
      answerWhileSending,
    );
    const res = await app.request(
      new Request('https://p.dev/x', {
        method: 'POST',
        body: endlessBody,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large', maxBodyBytes: 10 });
  });
});

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config';
import { veilo } from '../../src/middleware/veilo';

/**
 * Body rewriting assumes bodies arrive uncompressed, because `hono/proxy`
 * removes `accept-encoding` on the way out. If that ever stops holding, the
 * rewriter would be scanning compressed bytes and silently do nothing.
 */
describe('upstream encoding assumptions', () => {
  it('does not send accept-encoding upstream', async () => {
    let seen: string | null = 'unset';
    const upstream: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      seen = request.headers.get('accept-encoding');
      return new Response('<html><a href="https://o.test/x">l</a></html>', {
        headers: { 'content-type': 'text/html' },
      });
    };
    const app = new Hono();
    app.use('*', veilo({
      config: defineConfig({ routes: [{ match: { path: '/p' }, upstream: 'o.test', bodyRewrite: {} }] }),
      fetchImpl: upstream,
    }));

    const res = await app.request(new Request('https://p.dev/p', {
      headers: { 'accept-encoding': 'gzip, br' },
    }));
    expect(seen).toBeNull();
    expect(await res.text()).toContain('https://p.dev/x');
  });

  it('drops content-encoding and content-length from the response', async () => {
    const upstream: typeof fetch = async () =>
      new Response('plain text pretending to be gzip', {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '31' },
      });
    const app = new Hono();
    app.use('*', veilo({
      config: defineConfig({ routes: [{ match: { path: '/p' }, upstream: 'o.test' }] }),
      fetchImpl: upstream,
    }));
    const res = await app.request('https://p.dev/p');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
  });
});

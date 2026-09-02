import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';

/**
 * One whole-site mirror, end to end.
 *
 * The rewriting functions have unit tests of their own. What is covered here is
 * the route as an operator actually writes it — a host route with `bodyRewrite`
 * and nothing else — together with the event that reports whether the rewrite
 * happened. Both exist for the same reason: a mirror whose links still point at
 * the origin renders identically to one whose links were rewritten, so until a
 * visitor clicks one and leaves, nothing distinguishes them.
 */

type RouteInput = ConfigInput['routes'][number];
type BodyRewriteInput = NonNullable<RouteInput['bodyRewrite']>;

/** ASCII bytes. GB2312 is ASCII-compatible, so markup splices into it. */
const ascii = (text: string): Uint8Array => Uint8Array.from(text, (ch) => ch.charCodeAt(0));

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * Two Chinese characters as GB2312 bytes, spelled out because `TextEncoder`
 * emits UTF-8 and nothing else.
 *
 * The expected string is decoded from these same bytes rather than written as a
 * literal, so a case asserting "transcoded to UTF-8" tests the transcoding and
 * not my recollection of the code points.
 */
const GB2312_BYTES = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
const GB2312_TEXT = new TextDecoder('gb2312').decode(GB2312_BYTES);

/** A GB2312 page carrying one absolute upstream link. */
const gb2312Page = concat(
  ascii('<html><body><a href="https://upstream.test/next">'),
  GB2312_BYTES,
  ascii('</a></body></html>'),
);

const upstream: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  switch (new URL(request.url).pathname) {
    case '/page':
      return new Response(
        '<html><body>' +
          '<a href="https://upstream.test/next">next</a>' +
          '<img src="https://cdn.upstream.test/logo.png">' +
          '<form action="https://upstream.test/submit"></form>' +
          '<p>upstream.test in prose</p>' +
          '</body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    case '/protocol-relative':
      return new Response('<html><img src="//upstream.test/logo.png"></html>', {
        headers: { 'content-type': 'text/html' },
      });
    case '/lookalike':
      return new Response('<html><a href="https://upstream.test.evil.example/x">x</a></html>', {
        headers: { 'content-type': 'text/html' },
      });
    case '/redirect':
      return new Response(null, {
        status: 302,
        headers: { location: 'https://upstream.test/landed' },
      });
    case '/elsewhere':
      return new Response(null, {
        status: 302,
        headers: { location: 'https://other.example/landed' },
      });
    case '/gb2312':
      return new Response(gb2312Page, {
        headers: { 'content-type': 'text/html; charset=gb2312' },
      });
    case '/mislabelled':
      // A charset label no runtime resolves. Only `fallbackCharset` can save it.
      return new Response(gb2312Page, {
        headers: { 'content-type': 'text/html; charset=x-nonsense' },
      });
    case '/json':
      return new Response('{"link":"https://upstream.test/next"}', {
        headers: { 'content-type': 'application/json' },
      });
    case '/not-modified':
      return new Response(null, { status: 304, headers: { 'content-type': 'text/html' } });
    case '/no-body':
      // A 200 that carries nothing, as the answer to a HEAD does. The status
      // permits a body; none arrived.
      return new Response(null, { status: 200, headers: { 'content-type': 'text/html' } });
    default:
      return new Response('not found', { status: 404 });
  }
};

/** Mounts one route against the stub upstream and records its events. */
const mount = (route: RouteInput) => {
  const events: ProxyEvent[] = [];
  const app = new Hono();
  app.use(
    '*',
    jouska({
      config: defineConfig({ routes: [route] }),
      fetchImpl: upstream,
      onProxy: (event) => events.push(event),
    }),
  );
  return {
    events,
    get: (path: string) => app.request(new Request(`https://mirror.test${path}`)),
    fetch: (request: Request) => app.fetch(request, {}),
  };
};

const MATCH = { host: 'mirror.test' } as const;

/** The route this file is about: a whole site, body rewriting on. */
const mirror = (bodyRewrite: BodyRewriteInput = {}) =>
  mount({ id: 'mirror', match: MATCH, upstream: 'upstream.test', bodyRewrite });

/** The same site with rewriting never configured — the #29 default. */
const plainMirror = () => mount({ id: 'mirror', match: MATCH, upstream: 'upstream.test' });

describe('a whole-site mirror rewrites what it can prove belongs to the upstream', () => {
  it('points absolute href, src and action at the proxy, including a subdomain', async () => {
    const html = await (await mirror().get('/page')).text();
    expect(html).toContain('href="https://mirror.test/next"');
    expect(html).toContain('action="https://mirror.test/submit"');
    // `cdn.upstream.test` sits beneath the upstream, so it is the same site.
    expect(html).toContain('src="https://mirror.test/logo.png"');
    // Prose is left alone: rewriting text risks corrupting it for no
    // navigational gain.
    expect(html).toContain('upstream.test in prose');
  });

  it('keeps a protocol-relative reference protocol-relative', async () => {
    const html = await (await mirror().get('/protocol-relative')).text();
    // Pinning a scheme here would force https onto a page served over http.
    expect(html).toContain('src="//mirror.test/logo.png"');
    expect(html).not.toContain('https://mirror.test/logo.png');
  });

  it('leaves a lookalike host alone', async () => {
    const html = await (await mirror().get('/lookalike')).text();
    // `upstream.test.evil.example` is a different registrant. Substring
    // replacement used to turn it into a host under the proxy's own name.
    expect(html).toContain('href="https://upstream.test.evil.example/x"');
    expect(html).not.toContain('mirror.test.evil.example');
  });

  it('rewrites the redirect and reports that it did', async () => {
    const site = mirror();
    const res = await site.get('/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://mirror.test/landed');
    expect(site.events[0]).toMatchObject({ redirectRewritten: true, bodyRewritten: false });
  });

  it('reports no redirect rewrite when the Location left the upstream', async () => {
    const site = mirror();
    const res = await site.get('/elsewhere');
    expect(res.headers.get('location')).toBe('https://other.example/landed');
    expect(site.events[0]).toMatchObject({ redirectRewritten: false });
  });

  it('reports no redirect rewrite when header rewriting is off', async () => {
    const site = mount({
      id: 'mirror',
      match: MATCH,
      upstream: 'upstream.test',
      bodyRewrite: {},
      rewriteHeaders: false,
    });
    const res = await site.get('/redirect');
    expect(res.headers.get('location')).toBe('https://upstream.test/landed');
    expect(site.events[0]).toMatchObject({ redirectRewritten: false });
  });
});

describe('charset decides whether rewriting is even attempted', () => {
  it('transcodes a declared charset the runtime can decode', async () => {
    const site = mirror();
    const res = await site.get('/gb2312');
    // `text()` decodes as UTF-8 regardless of the header, so getting the
    // characters back at all proves the body was re-encoded.
    const html = await res.text();
    expect(html).toContain(GB2312_TEXT);
    expect(html).toContain('href="https://mirror.test/next"');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(site.events[0]).toMatchObject({ bodyRewritten: true });
  });

  it('uses fallbackCharset when the declared label is unusable', async () => {
    // The case a `declared ?? fallback` once missed entirely: a label that is
    // present but undecodable short-circuits the fallback it exists for.
    const site = mirror({ fallbackCharset: 'gb2312' });
    const res = await site.get('/mislabelled');
    const html = await res.text();
    expect(html).toContain(GB2312_TEXT);
    expect(html).toContain('href="https://mirror.test/next"');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(site.events[0]).toMatchObject({ bodyRewritten: true });
  });

  it('relays the bytes untouched when no usable charset is available', async () => {
    const site = mirror();
    const res = await site.get('/mislabelled');
    // Byte-identical: decoding with the wrong table would replace every
    // multi-byte character rather than rewrite the link.
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(gb2312Page);
    expect(res.headers.get('content-type')).toBe('text/html; charset=x-nonsense');
    expect(site.events[0]).toMatchObject({
      bodyRewritten: false,
      rewriteSkipped: 'charset_undecodable',
    });
  });
});

describe('the event names why a body was not rewritten', () => {
  it('names not_configured when the route has no bodyRewrite', async () => {
    const site = plainMirror();
    const html = await (await site.get('/page')).text();
    // The #29 case: forwarding works, the page opens, and every absolute link
    // still walks the visitor back to the origin.
    expect(html).toContain('href="https://upstream.test/next"');
    expect(site.events[0]).toMatchObject({
      bodyRewritten: false,
      rewriteSkipped: 'not_configured',
    });
  });

  it('names content_type for a type outside contentTypes', async () => {
    const site = mirror();
    const body = await (await site.get('/json')).text();
    expect(body).toContain('https://upstream.test/next');
    expect(site.events[0]).toMatchObject({ rewriteSkipped: 'content_type' });
  });

  it('names bodyless_status for a 304', async () => {
    const site = mirror();
    expect((await site.get('/not-modified')).status).toBe(304);
    expect(site.events[0]).toMatchObject({ rewriteSkipped: 'bodyless_status' });
  });

  it('names no_body when a body-permitting status carried none', async () => {
    const site = mirror();
    expect((await site.get('/no-body')).status).toBe(200);
    expect(site.events[0]).toMatchObject({ rewriteSkipped: 'no_body' });
  });

  it('reports a rewritten body without naming a reason', async () => {
    const site = mirror();
    await site.get('/page');
    expect(site.events[0]).toMatchObject({ bodyRewritten: true });
    expect(site.events[0]).not.toHaveProperty('rewriteSkipped');
  });

  it('states no rewrite conclusion for a request that never reached the upstream', async () => {
    const site = mount({
      id: 'mirror',
      match: MATCH,
      upstream: 'upstream.test',
      bodyRewrite: {},
      blockCountries: ['CU'],
    });
    const request = new Request('https://mirror.test/page');
    Object.defineProperty(request, 'cf', { value: { country: 'CU' } });
    expect((await site.fetch(request)).status).toBe(403);
    // Naming a skip reason here would describe a response that does not exist.
    expect(site.events[0]).toMatchObject({
      status: 403,
      outcome: 'refused',
      bodyRewritten: false,
      redirectRewritten: false,
    });
    expect(site.events[0]).not.toHaveProperty('rewriteSkipped');
  });
});

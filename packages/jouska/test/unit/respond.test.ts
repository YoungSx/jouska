import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';

const configWith = (route: Record<string, unknown>) =>
  defineConfig({ routes: [route as unknown as ConfigInput['routes'][number]] }).routes[0]!;

const parseError = (route: Record<string, unknown>): string[] => {
  try {
    configWith(route);
  } catch (error) {
    return (error as { issues: { message: string }[] }).issues.map((issue) => issue.message);
  }
  throw new Error('expected the config to be refused');
};

describe('respond', () => {
  it('answers with a redirect and defaults the status to 301', () => {
    const route = configWith({
      match: { path: '/old' },
      respond: { redirect: { to: '/new' } },
    });
    expect(route.respond).toEqual({ redirect: { to: '/new', status: 301 } });
  });

  it('answers with a fixed status, body and type', () => {
    const route = configWith({
      match: { path: '/x' },
      respond: { status: 503, contentType: 'text/html; charset=utf-8', body: '<p>back soon</p>' },
    });
    expect(route.respond).toEqual({
      status: 503,
      contentType: 'text/html; charset=utf-8',
      body: '<p>back soon</p>',
    });
  });

  it('refuses a redirect status outside the redirect set', () => {
    expect(() =>
      configWith({ match: { path: '/x' }, respond: { redirect: { to: '/y', status: 300 } } }),
    ).toThrow();
    // 304 is a cache validator, not a directive the route table can issue.
    expect(() =>
      configWith({ match: { path: '/x' }, respond: { redirect: { to: '/y', status: 304 } } }),
    ).toThrow();
  });

  it('refuses respond and upstream together', () => {
    const messages = parseError({
      match: { path: '/x' },
      upstream: 'origin.test',
      respond: { status: 503, contentType: 'text/plain', body: 'down' },
    });
    expect(messages.some((m) => m.includes('respond replaces forwarding entirely'))).toBe(true);
  });

  it('refuses respond beside the multi-candidate strategies too', () => {
    for (const strategy of [
      { upstreams: ['a.test'] },
      { trafficSplit: [{ upstream: 'a.test', weight: 1 }] },
    ]) {
      const messages = parseError({
        match: { path: '/x' },
        ...strategy,
        respond: { status: 503, contentType: 'text/plain', body: 'down' },
      });
      expect(messages.some((m) => m.includes('a route cannot both answer and forward'))).toBe(true);
    }
  });

  it('refuses a redirect to another host without the switch', () => {
    const messages = parseError({
      match: { path: '/x' },
      respond: { redirect: { to: 'https://elsewhere.test/y' } },
    });
    expect(messages.some((m) => m.includes('need respond.redirect.allowExternal: true'))).toBe(
      true,
    );
  });

  it('admits an external redirect when the switch is set', () => {
    const route = configWith({
      match: { path: '/x' },
      respond: { redirect: { to: 'https://elsewhere.test/y', allowExternal: true } },
    });
    expect(route.respond).toMatchObject({ redirect: { to: 'https://elsewhere.test/y' } });
  });

  it('refuses protocol-relative targets, which browsers read as another host', () => {
    for (const to of ['//elsewhere.test/y', '/\\elsewhere.test/y']) {
      expect(parseError({ match: { path: '/x' }, respond: { redirect: { to } } })).toEqual([
        expect.stringContaining('protocol-relative'),
      ]);
    }
  });

  it('refuses a redirect target that is neither a path nor a URL', () => {
    expect(
      parseError({
        match: { path: '/x' },
        respond: { redirect: { to: 'not a url', allowExternal: true } },
      }),
    ).toEqual([expect.stringContaining('neither a relative path nor an absolute URL')]);
  });

  it('refuses a body without a content-type', () => {
    expect(parseError({ match: { path: '/x' }, respond: { status: 503, body: 'down' } })).toEqual([
      expect.stringContaining('respond.body requires respond.contentType'),
    ]);
  });

  it('refuses a body on a status that cannot carry one', () => {
    for (const status of [204, 205, 304]) {
      expect(
        parseError({
          match: { path: '/x' },
          respond: { status, contentType: 'text/plain', body: 'down' },
        }),
      ).toEqual([expect.stringContaining('cannot carry a body')]);
    }
  });

  it('admits a bodyless 204', () => {
    const route = configWith({ match: { path: '/x' }, respond: { status: 204 } });
    expect(route.respond).toEqual({ status: 204 });
  });

  it('refuses a body on a redirect', () => {
    expect(
      parseError({ match: { path: '/x' }, respond: { redirect: { to: '/y' }, body: 'x' } }),
    ).toEqual([expect.stringContaining('carries no body')]);
  });

  it('refuses redirect and status together, and neither of them', () => {
    expect(
      parseError({
        match: { path: '/x' },
        respond: { redirect: { to: '/y' }, status: 503, contentType: 'text/plain' },
      }),
    ).toEqual([expect.stringContaining('exactly one of redirect or status (found 2)')]);
    expect(parseError({ match: { path: '/x' }, respond: {} })).toEqual([
      expect.stringContaining('exactly one of redirect or status (found 0)'),
    ]);
  });

  it('refuses reserved header names', () => {
    expect(
      parseError({
        match: { path: '/x' },
        respond: { status: 503, headers: { 'content-length': '5' } },
      }),
    ).toEqual([expect.stringContaining('may not write "content-length"')]);
  });

  it('refuses a location header beside a redirect, and admits it on a fixed answer', () => {
    expect(
      parseError({
        match: { path: '/x' },
        respond: { redirect: { to: '/y' }, headers: { location: '/z' } },
      }),
    ).toEqual([expect.stringContaining('the target is respond.redirect.to')]);
    const route = configWith({
      match: { path: '/x' },
      respond: { status: 201, headers: { location: '/z' } },
    });
    expect(route.respond).toMatchObject({ headers: { location: '/z' } });
  });

  it('is not a defaults field', () => {
    // A table-wide `respond` would turn every route into an edge answer.
    const config = defineConfig({
      routes: [{ match: { path: '/x' }, upstream: 'origin.test' }],
      defaults: { respond: { status: 503 } },
    } as unknown as ConfigInput);
    expect(config.routes[0]!.respond).toBeUndefined();
  });
});

describe('errorPages', () => {
  it('replaces the payload of an upstream failure, keyed by status', () => {
    const route = configWith({
      match: { path: '/x' },
      upstream: 'origin.test',
      errorPages: { 502: { body: '<h1>down</h1>', contentType: 'text/html; charset=utf-8' } },
    });
    expect(route.errorPages).toEqual({
      502: { body: '<h1>down</h1>', contentType: 'text/html; charset=utf-8' },
    });
  });

  it('refuses keys outside the 5xx range jouska can produce here', () => {
    expect(
      parseError({
        match: { path: '/x' },
        upstream: 'origin.test',
        errorPages: { 404: { body: 'x', contentType: 'text/html' } },
      }),
    ).toEqual([expect.stringContaining('only 5xx statuses can occur here')]);
  });

  it('refuses a page on a route that answers at the edge', () => {
    expect(
      parseError({
        match: { path: '/x' },
        respond: { status: 503, contentType: 'text/plain', body: 'down' },
        errorPages: { 502: { body: 'x', contentType: 'text/html' } },
      }),
    ).toEqual([expect.stringContaining('errorPages requires an upstream')]);
  });

  it('refuses a page with no body or no content-type', () => {
    for (const page of [{ contentType: 'text/html' }, { body: 'x' }]) {
      expect(() =>
        configWith({
          match: { path: '/x' },
          upstream: 'origin.test',
          errorPages: { 502: page as { body: string; contentType: string } },
        }),
      ).toThrow();
    }
  });

  it('refuses reserved header names on a page', () => {
    expect(
      parseError({
        match: { path: '/x' },
        upstream: 'origin.test',
        errorPages: {
          502: { body: 'x', contentType: 'text/html', headers: { 'set-cookie': 'a=b' } },
        },
      }),
    ).toEqual([expect.stringContaining('may not write "set-cookie"')]);
  });
});

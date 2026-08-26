import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/resolve';
import { firstAvailable, fromEnvVar, fromKV } from '../../src/sources';

const document = { version: 1, routes: [{ match: { path: '/a' }, upstream: 'o.test' }] };

describe('fromEnvVar', () => {
  it('accepts a var declared as a JSON object in wrangler config', async () => {
    // wrangler parses JSON vars at deploy time, so the Worker gets an object.
    const source = fromEnvVar({ CFG: document }, 'CFG');
    expect(await source()).toEqual(document);
  });

  it('accepts a var added by hand in the dashboard, which can only be a string', async () => {
    const source = fromEnvVar({ CFG: JSON.stringify(document) }, 'CFG');
    expect(await source()).toEqual(document);
  });

  it('tolerates surrounding whitespace', async () => {
    const source = fromEnvVar({ CFG: `\n  ${JSON.stringify(document)}  \n` }, 'CFG');
    expect(await source()).toEqual(document);
  });

  it('treats a missing variable as absent', async () => {
    expect(await fromEnvVar({}, 'CFG')()).toBeUndefined();
  });

  it('treats an empty string as absent rather than as invalid JSON', async () => {
    expect(await fromEnvVar({ CFG: '   ' }, 'CFG')()).toBeUndefined();
  });

  it('treats a missing env object as absent', async () => {
    expect(await fromEnvVar(undefined, 'CFG')()).toBeUndefined();
  });

  it('throws on malformed JSON so the caller decides how bad that is', async () => {
    await expect(fromEnvVar({ CFG: '{not json' }, 'CFG')()).rejects.toThrow();
  });

  it('feeds resolveConfig directly', async () => {
    const config = resolveConfig({ remote: await fromEnvVar({ CFG: document }, 'CFG')() });
    expect(config.routes[0]!.upstream).toBe('o.test');
  });
});

describe('fromKV', () => {
  it('reads the document as parsed JSON', async () => {
    const namespace = { get: async () => document };
    expect(await fromKV(namespace, 'routes')()).toEqual(document);
  });

  it('passes the key and json type through', async () => {
    let seen: { key: string; options: unknown } | undefined;
    const namespace = {
      get: async (key: string, options: { type: 'json' }) => {
        seen = { key, options };
        return document;
      },
    };
    await fromKV(namespace, 'my-routes')();
    expect(seen?.key).toBe('my-routes');
    expect(seen?.options).toEqual({ type: 'json' });
  });

  it('forwards cacheTtl so edge hits avoid a billed read', async () => {
    let options: Record<string, unknown> | undefined;
    const namespace = {
      get: async (_key: string, o: { type: 'json' }) => {
        options = o as Record<string, unknown>;
        return document;
      },
    };
    await fromKV(namespace, 'routes', { cacheTtlSeconds: 300 })();
    expect(options).toEqual({ type: 'json', cacheTtl: 300 });
  });

  it('omits cacheTtl when not requested', async () => {
    let options: Record<string, unknown> | undefined;
    const namespace = {
      get: async (_key: string, o: { type: 'json' }) => {
        options = o as Record<string, unknown>;
        return document;
      },
    };
    await fromKV(namespace, 'routes')();
    expect(options).not.toHaveProperty('cacheTtl');
  });

  it('reports a missing key as absent', async () => {
    expect(await fromKV({ get: async () => null }, 'routes')()).toBeNull();
  });
});

describe('firstAvailable', () => {
  const kvDoc = { version: 1, routes: [{ match: { path: '/kv' }, upstream: 'kv.test' }] };
  const envDoc = { version: 1, routes: [{ match: { path: '/env' }, upstream: 'env.test' }] };

  it('prefers the earlier source', async () => {
    const source = firstAvailable([
      fromKV({ get: async () => kvDoc }, 'routes'),
      fromEnvVar({ CFG: envDoc }, 'CFG'),
    ]);
    expect(await source()).toEqual(kvDoc);
  });

  it('falls back when the earlier source is empty', async () => {
    const source = firstAvailable([
      fromKV({ get: async () => null }, 'routes'),
      fromEnvVar({ CFG: envDoc }, 'CFG'),
    ]);
    expect(await source()).toEqual(envDoc);
  });

  it('treats a throwing source as absent so it cannot mask a working one', async () => {
    const broken = async () => {
      throw new Error('KV unreachable');
    };
    const source = firstAvailable([broken, fromEnvVar({ CFG: envDoc }, 'CFG')]);
    expect(await source()).toEqual(envDoc);
  });

  it('reports which source failed', async () => {
    const failures: number[] = [];
    const broken = async () => {
      throw new Error('boom');
    };
    const source = firstAvailable([broken, broken, fromEnvVar({ CFG: envDoc }, 'CFG')], (_e, i) =>
      failures.push(i),
    );
    await source();
    expect(failures).toEqual([0, 1]);
  });

  it('returns undefined when every source is empty', async () => {
    expect(await firstAvailable([async () => undefined, async () => null])()).toBeUndefined();
  });

  it('does not consult later sources once one yields', async () => {
    let consulted = false;
    const source = firstAvailable([
      fromEnvVar({ CFG: envDoc }, 'CFG'),
      async () => {
        consulted = true;
        return kvDoc;
      },
    ]);
    await source();
    expect(consulted).toBe(false);
  });
});

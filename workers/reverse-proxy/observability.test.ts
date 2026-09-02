import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { __resetConfigCache } from './index.js';
import { createProxySink } from './observability.js';
import type { ProxyEvent } from 'jouska';

/**
 * Covers the receivers only: what lands in the dataset, the cardinality bound,
 * and the degrade-don't-fail path. The library's reporting itself is tested in
 * `packages/jouska`; what is under test here is that the assembly is correct.
 */

const event = (overrides: Partial<ProxyEvent> = {}): ProxyEvent => ({
  routeId: 'example',
  upstream: 'origin.test',
  method: 'GET',
  path: '/api/models',
  status: 200,
  durationMs: 42,
  attempts: 1,
  outcome: 'ok',
  // Both are required on the event: every proxied response has an answer for
  // them, and making them optional would push an undefined check onto every
  // receiver. `rewriteSkipped` stays absent — no reason is named when nothing
  // was skipped.
  bodyRewritten: false,
  redirectRewritten: false,
  ...overrides,
});

/** Records every data point written, standing in for the Analytics binding. */
const recordingDataset = () => {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  return {
    points,
    writeDataPoint: (point: (typeof points)[number]) => {
      points.push(point);
    },
  };
};

/** Collects access-log lines instead of spying the pool's console. */
const collectingLog = () => {
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };
  return { lines, log };
};

describe('analytics receiver', () => {
  it('writes one data point per event, keyed by routeId', () => {
    const dataset = recordingDataset();
    const sink = createProxySink({ ANALYTICS: dataset });
    sink?.(event());

    expect(dataset.points).toHaveLength(1);
    const point = dataset.points[0];
    expect(point?.indexes).toEqual(['example']);
    // The trailing blob is the cache state, empty on a route without caching.
    expect(point?.blobs).toEqual(['origin.test', 'GET', 'ok', '']);
    expect(point?.doubles).toEqual([200, 42, 1]);
  });

  it('carries the cache state so a hit rate is queryable', () => {
    const dataset = recordingDataset();
    const sink = createProxySink({ ANALYTICS: dataset });
    sink?.(event({ cache: 'hit' }));
    sink?.(event({ cache: 'bypass' }));

    expect(dataset.points.map((point) => point.blobs?.[3])).toEqual(['hit', 'bypass']);
  });

  it('bounds the index to the schema limit even for a hostile routeId', () => {
    // routeId can be synthesised from host + path + index for routes without
    // an id; this proves a long one cannot fail or blow up the write.
    const dataset = recordingDataset();
    const sink = createProxySink({ ANALYTICS: dataset });
    sink?.(event({ routeId: 'x'.repeat(300) }));

    const index = dataset.points[0]?.indexes?.[0] ?? '';
    expect(new TextEncoder().encode(index).length).toBeLessThanOrEqual(96);
  });

  it('does not include path in any label, so cardinality stays bounded', () => {
    // Two hits on the same route with different paths must be the same series.
    const dataset = recordingDataset();
    const sink = createProxySink({ ANALYTICS: dataset });
    sink?.(event({ path: '/a' }));
    sink?.(event({ path: '/b' }));

    expect(dataset.points[0]?.indexes).toEqual(dataset.points[1]?.indexes);
    expect(JSON.stringify(dataset.points)).not.toContain('/a');
  });
});

describe('access-logs receiver', () => {
  it('emits one structured line per event when enabled', () => {
    const { lines, log } = collectingLog();
    const sink = createProxySink({ ACCESS_LOGS: 'true' }, log);
    sink?.(event({ path: '/x'.repeat(200) }));

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      message: 'proxy',
      routeId: 'example',
      upstream: 'origin.test',
      method: 'GET',
      status: 200,
      durationMs: 42,
      attempts: 1,
      outcome: 'ok',
    });
    // The path is carried but clipped, so a hostile URL cannot balloon a line.
    expect(String(line.path).length).toBeLessThanOrEqual(256);
    // No cache on this route, so the field is absent rather than null.
    expect('cache' in line).toBe(false);
  });

  it('carries the cache state when the route has one', () => {
    const { lines, log } = collectingLog();
    const sink = createProxySink({ ACCESS_LOGS: 'true' }, log);
    sink?.(event({ cache: 'stale' }));
    expect((JSON.parse(lines[0] ?? '{}') as Record<string, unknown>).cache).toBe('stale');
  });

  it('is off unless ACCESS_LOGS is exactly "true"', () => {
    const { log } = collectingLog();
    expect(createProxySink({ ACCESS_LOGS: 'TRUE' }, log)).toBeUndefined();
    expect(createProxySink({ ACCESS_LOGS: '1' }, log)).toBeUndefined();
    expect(createProxySink({}, log)).toBeUndefined();
  });
});

describe('fan-out', () => {
  it('writes to both receivers when both are configured', () => {
    const dataset = recordingDataset();
    const { lines, log } = collectingLog();
    const sink = createProxySink({ ANALYTICS: dataset, ACCESS_LOGS: 'true' }, log);
    sink?.(event());

    expect(dataset.points).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it('degrades a failing receiver instead of failing the request', () => {
    // The library swallows onProxy throws, so a receiver that throws would die
    // silently on every hit. Degrading once, loudly, is the honest failure.
    const dataset = recordingDataset();
    dataset.writeDataPoint = () => {
      throw new Error('binding gone');
    };
    const { lines, log } = collectingLog();
    const errorLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      // The pool expands one call into several args; rejoin for one entry.
      errorLines.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      const sink = createProxySink({ ANALYTICS: dataset, ACCESS_LOGS: 'true' }, log);
      sink?.(event());
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toContain('analytics');

      sink?.(event());
      // The disabled receiver logs nothing further, while the healthy
      // access-logs receiver keeps producing lines.
      expect(errorLines).toHaveLength(1);
      expect(lines).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns undefined when nothing is configured, so onProxy stays unset', () => {
    const { log } = collectingLog();
    expect(createProxySink({}, log)).toBeUndefined();
  });
});

describe('worker wiring', () => {
  beforeEach(() => __resetConfigCache());

  const table = {
    version: 1,
    routes: [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test' }],
  };
  const upstream: typeof fetch = async () => new Response('ok');
  const ctx = {} as ExecutionContext;

  it('reports through the dataset when ANALYTICS is bound', async () => {
    const dataset = recordingDataset();
    const res = await worker.fetch(
      new Request('https://p.dev/api/x'),
      { JOUSKA_CONFIG: table, UPSTREAM_FETCH: upstream, ANALYTICS: dataset },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(dataset.points).toHaveLength(1);
    expect(dataset.points[0]?.indexes).toEqual(['api']);
  });

  it('does not install onProxy when no receiver is configured', async () => {
    // Nothing bound, nothing to do: the middleware runs without a reporter.
    const res = await worker.fetch(
      new Request('https://p.dev/api/x'),
      { JOUSKA_CONFIG: table, UPSTREAM_FETCH: upstream },
      ctx,
    );
    expect(res.status).toBe(200);
  });
});

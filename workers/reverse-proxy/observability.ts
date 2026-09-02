/**
 * Optional observability receivers for the reference Worker.
 *
 * The library stays binding-free on purpose (see the README's "Observability"
 * section): turning a proxy event into metrics or logs is a deployment
 * decision, so it lives here — one file, deletable, and a no-op when nothing
 * is configured. Two receivers, both optional:
 *
 * - `ANALYTICS` (Analytics Engine): one data point per proxied request, from
 *   which per-route latency percentiles, 4xx/5xx/timeout rates and response-cache
 *   hit rates are queried with the Analytics Engine SQL API.
 * - `ACCESS_LOGS: "true"`: one structured JSON line per proxied request, which
 *   Workers Logs picks up because the deployment has `observability` enabled.
 *
 * Two properties the README calls out shape both:
 *
 * - **`onProxy` throws are swallowed by the library**, deliberately, so a
 *   receiver cannot rely on its errors being seen. Each one therefore catches
 *   its own errors: the failing receiver logs once and disables itself, so
 *   observability degrades to silent rather than failing every request or
 *   spamming a log line per hit.
 * - **Cardinality has an upper bound.** Analytics Engine indexes only
 *   `routeId`, which is stable; `path` never reaches it, because a mirror site
 *   serving arbitrary URLs would grow unbounded dimensions. The log line may
 *   carry `path`, but truncated, so a hostile URL cannot balloon a line.
 *
 * No `ctx.waitUntil` anywhere: `writeDataPoint` and `console.*` are synchronous
 * and buffered by the runtime, so neither holds the response. A receiver that
 * does real async I/O (a webhook, an external collector) is the one that needs
 * its work wrapped in `waitUntil` — this file is not that receiver.
 */
import type { ProxyEvent } from 'jouska';

import type { Env } from './index.js';

/** Analytics Engine rejects an index over 96 bytes. */
const INDEX_LIMIT = 96;
/** Analytics Engine blobs share a 5 KiB budget; these fields stay far under it. */
const BLOB_LIMIT = 128;
/** Cap for the path in a log line, which the event leaves unbounded. */
const LOG_PATH_LIMIT = 256;

/** Writes one proxy event somewhere. Never throws past its first failure. */
export type ProxySink = (event: ProxyEvent) => void;

const encoder = new TextEncoder();

/** Clips a string to a byte budget on a character boundary. */
const clip = (value: string, limit: number): string => {
  const bytes = encoder.encode(value);
  if (bytes.length <= limit) {
    return value;
  }
  // A cut multibyte tail decodes to U+FFFD; drop it rather than emit a
  // half-character that no query would group sensibly.
  return new TextDecoder().decode(bytes.slice(0, limit)).replace(/�+$/u, '');
};

/**
 * One data point per proxied request.
 *
 * `index: routeId` is what every useful query groups by. Layout: blobs
 * `[upstream, method, outcome, cache]`, doubles `[status, durationMs, attempts]`.
 *
 * `cache` is appended rather than inserted, so a query written against the
 * previous three-blob layout keeps returning the same columns. It is the empty
 * string on a route without caching, which is what distinguishes "not caching"
 * from a `bypass` the cache decided on.
 */
const analyticsReceiver =
  (dataset: AnalyticsEngineDataset): ProxySink =>
  (event) => {
    dataset.writeDataPoint({
      indexes: [clip(event.routeId, INDEX_LIMIT)],
      blobs: [clip(event.upstream, BLOB_LIMIT), event.method, event.outcome, event.cache ?? ''],
      doubles: [event.status, event.durationMs, event.attempts],
    });
  };

/** One structured JSON line per proxied request, consumed by Workers Logs. */
const logsReceiver =
  (log: (line: string) => void): ProxySink =>
  (event) => {
    log(
      JSON.stringify({
        message: 'proxy',
        routeId: event.routeId,
        upstream: event.upstream,
        method: event.method,
        path: clip(event.path, LOG_PATH_LIMIT),
        status: event.status,
        durationMs: event.durationMs,
        attempts: event.attempts,
        outcome: event.outcome,
        // Omitted by JSON.stringify on a route without caching, so a line only
        // carries the field when there is a cache to report on.
        cache: event.cache,
      }),
    );
  };

/**
 * Builds the receiver fan-out from whatever the environment offers, returning
 * undefined when nothing is configured so `onProxy` stays unset and costs
 * nothing at all.
 *
 * `log` is where the access-log line goes; it defaults to `console.info`,
 * which Workers Logs picks up. Injectable because the pool runtime's console
 * is a different object from a test's, so output cannot be spied.
 */
export const createProxySink = (
  env: Env,
  log: (line: string) => void = console.info.bind(console),
): ProxySink | undefined => {
  const receivers: Array<{ name: string; enabled: boolean; write: ProxySink }> = [];
  if (env.ANALYTICS !== undefined) {
    receivers.push({ name: 'analytics', enabled: true, write: analyticsReceiver(env.ANALYTICS) });
  }
  if (env.ACCESS_LOGS === 'true') {
    receivers.push({ name: 'access-logs', enabled: true, write: logsReceiver(log) });
  }
  if (receivers.length === 0) {
    return undefined;
  }

  return (event: ProxyEvent) => {
    for (const receiver of receivers) {
      if (!receiver.enabled) {
        continue;
      }
      try {
        receiver.write(event);
      } catch (error) {
        // Degrade, don't spam: the receiver reports its own failure once and
        // goes quiet, because the library swallows `onProxy` throws by design.
        receiver.enabled = false;
        console.error(`jouska: ${receiver.name} receiver disabled after an error`, error);
      }
    }
  };
};

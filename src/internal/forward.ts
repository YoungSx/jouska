import { proxy } from 'hono/proxy';
import type { Route } from '../config';

/** Methods safe to replay after a failure. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export const isRetryable = (method: string): boolean => IDEMPOTENT.has(method.toUpperCase());

export interface ForwardOptions {
  route: Route;
  target: URL;
  request: Request;
  /** Overridable for tests; defaults to the runtime `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Forwards a request upstream with a per-attempt deadline and bounded retries.
 *
 * `hono/proxy` handles hop-by-hop header stripping, `duplex: 'half'` for
 * streamed bodies, and dropping `accept-encoding` so the body arrives
 * uncompressed. What it does not do — and what this adds — is deadlines,
 * retries, and forwarding provenance headers.
 *
 * Only idempotent methods retry: a request with a body cannot be replayed
 * anyway, since its stream is consumed by the first attempt.
 */
export const forward = async ({ route, target, request, fetchImpl }: ForwardOptions): Promise<Response> => {
  const url = new URL(request.url);
  const attempts = isRetryable(request.method) ? route.retries + 1 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await proxy(target, {
        raw: request,
        // Workers allows only 6 outbound connections per request; one upstream
        // per attempt keeps us far below that even with retries.
        signal: AbortSignal.timeout(route.timeoutMs),
        headers: {
          ...route.upstreamHeaders,
          host: target.host,
          'x-forwarded-host': url.host,
          'x-forwarded-proto': url.protocol.replace(':', ''),
        },
        ...(fetchImpl ? { customFetch: fetchImpl } : {}),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

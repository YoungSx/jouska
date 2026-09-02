import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';
import type { StreamReport } from '../../src/internal/stream-watch';

/**
 * Streaming responses, which is where the per-attempt deadline used to reach
 * past the headers it was documented to bound and cut answers in half.
 */

interface UpstreamOptions {
  /** Frames emitted in order. */
  frames?: readonly string[];
  /** Delay before each frame. */
  gapMs?: number;
  /** Emit this many frames, then fall silent without closing. */
  stallAfter?: number;
  /** Delay before the response headers themselves. */
  headDelayMs?: number;
  contentType?: string;
  cacheControl?: string;
}

/** Records whether the outbound request was ever aborted. */
interface UpstreamSpy {
  fetchImpl: typeof fetch;
  aborted: () => boolean;
  abortReason: () => string | undefined;
}

/**
 * Sleeps, but abandons the wait when the request is aborted — which is what a
 * real `fetch` does and what a plain `setTimeout` does not. Without this the
 * head deadline appears not to work, because nothing is listening for it.
 */
const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

const sseUpstream = ({
  frames = ['data: a\n\n', 'data: b\n\n', 'data: c\n\n'],
  gapMs = 20,
  stallAfter,
  headDelayMs = 0,
  contentType = 'text/event-stream',
  cacheControl,
}: UpstreamOptions = {}): UpstreamSpy => {
  let abortName: string | undefined;
  const fetchImpl: typeof fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input as string);
    const signal = request.signal;
    if (headDelayMs > 0) {
      await abortableSleep(headDelayMs, signal);
    }
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (let i = 0; i < frames.length; i += 1) {
          if (stallAfter === i) {
            // Falls silent with the stream open — an upstream that died without
            // closing, which is what an idle deadline exists to notice.
            return;
          }
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          if (signal.aborted) {
            abortName = (signal.reason as Error | undefined)?.name ?? 'aborted';
            return;
          }
          controller.enqueue(encoder.encode(frames[i]!));
        }
        controller.close();
      },
    });
    const headers = new Headers({ 'content-type': contentType });
    if (cacheControl !== undefined) {
      headers.set('cache-control', cacheControl);
    }
    return new Response(body, { headers });
  };
  return {
    fetchImpl,
    aborted: () => abortName !== undefined,
    abortReason: () => abortName,
  };
};

const route = (extra: Record<string, unknown> = {}): ConfigInput =>
  ({
    routes: [{ match: { host: 'p.dev' }, upstream: 'o.test', ...extra }],
  }) as ConfigInput;

/** Builds the app and captures the single proxy event. */
const proxied = (config: ConfigInput, fetchImpl: typeof fetch) => {
  const events: ProxyEvent[] = [];
  const app = new Hono();
  app.use('*', jouska({ config: defineConfig(config), fetchImpl, onProxy: (e) => events.push(e) }));
  return { app, events };
};

/** Reads a response body, returning what arrived and how it ended. */
const read = async (
  response: Response,
): Promise<{ text: string; error?: string; chunks: number }> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let chunks = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks += 1;
      text += decoder.decode(value, { stream: true });
    }
    return { text, chunks };
  } catch (error) {
    return { text, chunks, error: (error as Error).name };
  }
};

describe('streaming responses', () => {
  it('relays a stream that outlasts timeoutMs, which bounds headers only', async () => {
    // Six frames 30ms apart run to ~180ms, well past the 60ms head deadline.
    // This used to arrive as `200 OK` with two frames and a dead socket.
    const upstream = sseUpstream({
      frames: Array.from({ length: 6 }, (_, i) => `data: ${i}\n\n`),
      gapMs: 30,
    });
    const { app, events } = proxied(
      route({ timeoutMs: 60, totalTimeoutMs: 60, streamIdleTimeoutMs: 5_000 }),
      upstream.fetchImpl,
    );

    const response = await app.request('https://p.dev/v1/messages');
    const seen = await read(response);

    expect(response.status).toBe(200);
    expect(seen.error).toBeUndefined();
    expect(seen.text).toBe('data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\ndata: 5\n\n');
    expect(upstream.aborted()).toBe(false);
    await expect(events[0]!.stream).resolves.toMatchObject({ outcome: 'complete' });
  });

  it('still bounds the headers themselves with timeoutMs', async () => {
    const upstream = sseUpstream({ headDelayMs: 200 });
    const { app, events } = proxied(
      route({ timeoutMs: 50, totalTimeoutMs: 50 }),
      upstream.fetchImpl,
    );

    const response = await app.request('https://p.dev/v1/messages');

    expect(response.status).toBe(504);
    expect(events[0]!.outcome).toBe('timeout');
    // Nothing streamed, so there is no stream to report on.
    expect(events[0]!.stream).toBeUndefined();
  });

  it('cuts a stream that never sends a first byte, and says so', async () => {
    const upstream = sseUpstream({ stallAfter: 0 });
    const { app, events } = proxied(
      route({ firstChunkTimeoutMs: 60, streamIdleTimeoutMs: 5_000 }),
      upstream.fetchImpl,
    );

    const response = await app.request('https://p.dev/v1/messages');
    const seen = await read(response);

    // The headers were already sent, so the status cannot carry the failure.
    expect(response.status).toBe(200);
    expect(seen.text).toBe('');
    expect(seen.error).toBe('StreamDeadlineError');
    const report = (await events[0]!.stream) as StreamReport;
    expect(report.outcome).toBe('first_chunk_timeout');
    expect(report.bytes).toBe(0);
  });

  it('cuts a stream that stalls after starting, keeping what arrived', async () => {
    const upstream = sseUpstream({ stallAfter: 2, gapMs: 10 });
    const { app, events } = proxied(
      route({ firstChunkTimeoutMs: 5_000, streamIdleTimeoutMs: 60 }),
      upstream.fetchImpl,
    );

    const response = await app.request('https://p.dev/v1/messages');
    const seen = await read(response);

    expect(seen.text).toBe('data: a\n\ndata: b\n\n');
    expect(seen.error).toBe('StreamDeadlineError');
    const report = (await events[0]!.stream) as StreamReport;
    expect(report.outcome).toBe('idle_timeout');
    expect(report.bytes).toBe('data: a\n\ndata: b\n\n'.length);
  });

  it('tells the upstream to stop when a body deadline expires', async () => {
    // The upstream checks its signal between frames, so a walk that keeps
    // generating after the client is gone would show up as extra frames.
    const upstream = sseUpstream({
      frames: Array.from({ length: 8 }, (_, i) => `data: ${i}\n\n`),
      gapMs: 40,
    });
    const { app } = proxied(
      route({ firstChunkTimeoutMs: 5_000, streamIdleTimeoutMs: 20 }),
      upstream.fetchImpl,
    );

    const response = await app.request('https://p.dev/v1/messages');
    await read(response);
    // Give the upstream a frame's worth of time to notice.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(upstream.aborted()).toBe(true);
    expect(upstream.abortReason()).toBe('StreamDeadlineError');
  });

  it('does not rewrite a stream, whatever contentTypes says', async () => {
    const upstream = sseUpstream({
      frames: ['data: {"url":"https://o.test/x"}\n\n'],
      gapMs: 5,
    });
    const { app, events } = proxied(
      route({
        // Both a matching prefix and a literal rule, the combination that used to
        // sever every chunk mid-`data:`.
        bodyRewrite: { contentTypes: ['text/'], replace: [{ from: 'o.test', to: 'p.dev' }] },
      }),
      upstream.fetchImpl,
    );

    const response = await app.request('https://p.dev/v1/messages');
    const seen = await read(response);

    expect(seen.text).toBe('data: {"url":"https://o.test/x"}\n\n');
    expect(events[0]!.bodyRewritten).toBe(false);
    expect(events[0]!.rewriteSkipped).toBe('streaming_media');
  });

  it('does not cache a stream, whatever contentTypes says', async () => {
    const store = new Map<string, Response>();
    const cacheImpl = {
      match: async (key: Request) => store.get(key.url)?.clone(),
      put: async (key: Request, value: Response) => {
        store.set(key.url, value);
      },
      delete: async (key: Request) => store.delete(key.url),
    };
    const upstream = sseUpstream({
      frames: ['data: a\n\n'],
      gapMs: 5,
      cacheControl: 'public, max-age=600',
    });
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig(route({ cache: { contentTypes: ['text/'] } })),
        fetchImpl: upstream.fetchImpl,
        cacheImpl,
      }),
    );

    const first = await app.request('https://p.dev/v1/messages');
    await first.text();
    const second = await app.request('https://p.dev/v1/messages');
    await second.text();

    expect(first.headers.get('x-jouska-cache')).toBe('miss');
    // Would be `hit` if the stream had been stored.
    expect(second.headers.get('x-jouska-cache')).toBe('miss');
    expect(store.size).toBe(0);
  });

  it('reports a client that stops reading rather than a deadline', async () => {
    const upstream = sseUpstream({ gapMs: 10 });
    const { app, events } = proxied(
      route({ firstChunkTimeoutMs: 5_000, streamIdleTimeoutMs: 5_000 }),
      upstream.fetchImpl,
    );

    const response = await app.request('https://p.dev/v1/messages');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    await expect(events[0]!.stream).resolves.toMatchObject({ outcome: 'client_closed' });
  });

  it('leaves a bodyless response without a stream report', async () => {
    const noBody: typeof fetch = async () => new Response(null, { status: 204 });
    const { app, events } = proxied(route(), noBody);

    await app.request('https://p.dev/v1/messages');

    expect(events[0]!.status).toBe(204);
    expect(events[0]!.stream).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  StreamDeadlineError,
  watchStream,
  type StreamReport,
} from '../../src/internal/stream-watch';

/** A body that emits `frames` with `gapMs` between them, optionally never closing. */
const upstream = (
  frames: readonly string[],
  gapMs: number,
  options: { stallAfter?: number; failAfter?: number } = {},
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (let i = 0; i < frames.length; i += 1) {
        if (options.stallAfter === i) {
          // Neither closes nor errors: the shape of an upstream that died with
          // the socket still open.
          return;
        }
        if (options.failAfter === i) {
          controller.error(new Error('connection reset'));
          return;
        }
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(frames[i]!));
      }
      controller.close();
    },
  });

const FRAMES = ['data: a\n\n', 'data: b\n\n', 'data: c\n\n'] as const;

/** Reads a monitored stream to its end, capturing what the client sees. */
const drain = async (
  stream: ReadableStream<Uint8Array>,
): Promise<{ text: string; error?: { name: string; outcome?: string } }> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    return { text };
  } catch (error) {
    return {
      text,
      error: {
        name: (error as Error).name,
        ...(error instanceof StreamDeadlineError ? { outcome: error.outcome } : {}),
      },
    };
  }
};

/** Collects the single report plus whether the upstream was cut. */
const watched = (
  body: ReadableStream<Uint8Array>,
  firstChunkTimeoutMs: number,
  streamIdleTimeoutMs: number,
): {
  stream: ReadableStream<Uint8Array>;
  reports: StreamReport[];
  aborts: string[];
} => {
  const reports: StreamReport[] = [];
  const aborts: string[] = [];
  const stream = watchStream({
    body,
    firstChunkTimeoutMs,
    streamIdleTimeoutMs,
    abort: (reason) => aborts.push(reason.name),
    onEnd: (report) => reports.push(report),
  });
  return { stream, reports, aborts };
};

describe('watchStream', () => {
  it('relays a healthy stream and reports it complete', async () => {
    const { stream, reports, aborts } = watched(upstream(FRAMES, 10), 1_000, 1_000);
    const seen = await drain(stream);

    expect(seen.text).toBe(FRAMES.join(''));
    expect(seen.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.outcome).toBe('complete');
    expect(reports[0]!.bytes).toBe(FRAMES.join('').length);
    expect(aborts).toEqual([]);
  });

  it('does not kill a slow stream that keeps sending', async () => {
    // Four gaps of 40ms outlast a 60ms idle deadline only if it fails to reset.
    const { stream, reports } = watched(upstream(FRAMES, 40), 1_000, 60);
    const seen = await drain(stream);

    expect(seen.text).toBe(FRAMES.join(''));
    expect(reports[0]!.outcome).toBe('complete');
  });

  it('fails the stream when no first byte arrives, and cuts the upstream', async () => {
    const { stream, reports, aborts } = watched(upstream(FRAMES, 10, { stallAfter: 0 }), 50, 1_000);
    const seen = await drain(stream);

    expect(seen.text).toBe('');
    expect(seen.error).toEqual({ name: 'StreamDeadlineError', outcome: 'first_chunk_timeout' });
    expect(reports).toEqual([
      { outcome: 'first_chunk_timeout', bytes: 0, durationMs: expect.any(Number) },
    ]);
    // The upstream is told to stop, so a metered API is not left generating.
    expect(aborts).toEqual(['StreamDeadlineError']);
  });

  it('fails the stream when it stalls after starting, keeping what arrived', async () => {
    const { stream, reports, aborts } = watched(upstream(FRAMES, 10, { stallAfter: 2 }), 1_000, 50);
    const seen = await drain(stream);

    // The bytes that did arrive reached the client before the deadline fired:
    // a reader keeps them, unlike `.text()`, which discards the lot.
    expect(seen.text).toBe('data: a\n\ndata: b\n\n');
    expect(seen.error).toEqual({ name: 'StreamDeadlineError', outcome: 'idle_timeout' });
    expect(reports[0]!.outcome).toBe('idle_timeout');
    expect(reports[0]!.bytes).toBe('data: a\n\ndata: b\n\n'.length);
    expect(aborts).toEqual(['StreamDeadlineError']);
  });

  it('reports an upstream failure as a reset rather than a deadline', async () => {
    const { stream, reports, aborts } = watched(
      upstream(FRAMES, 10, { failAfter: 1 }),
      1_000,
      1_000,
    );
    const seen = await drain(stream);

    expect(seen.text).toBe('data: a\n\n');
    expect(seen.error?.name).toBe('Error');
    expect(reports[0]!.outcome).toBe('upstream_reset');
    // Nothing to cut: the connection is what failed.
    expect(aborts).toEqual([]);
  });

  it('reports a client that stops reading, and disarms the deadline', async () => {
    const { stream, reports } = watched(upstream(FRAMES, 10), 1_000, 1_000);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(reports).toEqual([
      { outcome: 'client_closed', bytes: 'data: a\n\n'.length, durationMs: expect.any(Number) },
    ]);
  });

  it('reports exactly once, whatever ends the stream', async () => {
    const { stream, reports } = watched(upstream(FRAMES, 10, { stallAfter: 1 }), 1_000, 40);
    await drain(stream);
    // The deadline fires, which errors the stream, which cancels the readable
    // side — two events for one ending.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(reports).toHaveLength(1);
  });
});

/**
 * Body-phase deadlines: how long to wait for the first byte, and how long the
 * stream may then go quiet.
 *
 * Headers arriving is not the same event as the answer arriving. A model that
 * thinks for two minutes before emitting a token sends its `200` immediately,
 * so a deadline that stops at headers says nothing about whether the body is
 * still coming — and one that spans the whole response cuts a working answer off
 * mid-sentence. Verified against a real SSE upstream: an 8-event stream spanning
 * 400ms under a 150ms per-attempt deadline reached the client as `200 OK`, two
 * events, then a dead socket, with the proxy's own event recording a successful
 * 200. The client cannot tell that apart from the model finishing.
 *
 * So the body gets two deadlines of its own, measured between reads rather than
 * across the response — the shape nginx has used for `proxy_read_timeout`
 * throughout its history ("set only between two successive read operations, not
 * for the transmission of the whole response"). There is deliberately no
 * whole-body ceiling: as long as bytes keep arriving, the answer keeps streaming.
 *
 * The two are separate numbers because they measure different failures. Silence
 * before the first byte is an upstream still working; silence between bytes is a
 * connection that died. One number for both either kills the slow starter or
 * waits out its budget before noticing the corpse.
 */

/** Why a monitored body stopped. */
export type StreamOutcome =
  /** The upstream closed the stream normally. */
  | 'complete'
  /** No first byte arrived within `firstChunkTimeoutMs`. */
  | 'first_chunk_timeout'
  /** The stream went `streamIdleTimeoutMs` without a byte after starting. */
  | 'idle_timeout'
  /** The upstream connection failed or was reset mid-stream. */
  | 'upstream_reset'
  /** The client stopped reading — a closed tab, an aborted request. */
  | 'client_closed';

/** What one monitored body did, reported once it is over. */
export interface StreamReport {
  outcome: StreamOutcome;
  /** Body bytes relayed to the client before the stream ended. */
  bytes: number;
  /** Wall-clock milliseconds from response headers to the stream ending. */
  durationMs: number;
}

/**
 * Raised into the client's stream when a body deadline expires.
 *
 * A distinct class rather than a reused `AbortError`: a deadline this proxy
 * enforced and a client that hung up produce the same broken stream, and only
 * one of them is worth alerting on. This error is created on our side of the
 * boundary — the client's reader sees it directly — so unlike the reason handed
 * to `abort`, its identity survives.
 */
export class StreamDeadlineError extends Error {
  override readonly name = 'StreamDeadlineError';
  constructor(
    readonly outcome: 'first_chunk_timeout' | 'idle_timeout',
    message: string,
  ) {
    super(message);
  }
}

export interface WatchStreamOptions {
  /** The upstream body to monitor. */
  body: ReadableStream<Uint8Array>;
  /** Deadline for the first byte, measured from response headers. */
  firstChunkTimeoutMs: number;
  /** Deadline between bytes, once the first has arrived. */
  streamIdleTimeoutMs: number;
  /**
   * Cuts the upstream connection when a deadline expires.
   *
   * Erroring the stream alone would leave the upstream generating into a socket
   * nobody reads, which on a metered API is a bill for output that is discarded.
   */
  abort: (reason: Error) => void;
  /** Called exactly once, whatever ends the stream. */
  onEnd: (report: StreamReport) => void;
}

/**
 * Wraps a body so its two deadlines are enforced and its ending is reported.
 *
 * Applied directly to the upstream body, before any rewriting. The monitor
 * measures whether the *upstream* is still sending; stacked outside a rewriter
 * it would instead measure what the rewriter had finished deciding, and a
 * rewriter legitimately holds bytes back across a chunk boundary — so a live
 * stream could read as idle. Verified in workerd: with the monitor inside, an
 * idle abort still propagates out through the rewrite transform to the client.
 *
 * The timer is cleared on every exit — normal end, deadline, upstream failure,
 * client cancel. Workers reuses isolates, so a timer left armed outlives the
 * request that created it.
 */
export const watchStream = ({
  body,
  firstChunkTimeoutMs,
  streamIdleTimeoutMs,
  abort,
  onEnd,
}: WatchStreamOptions): ReadableStream<Uint8Array> => {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bytes = 0;
  // Guards `onEnd` against a second call: a deadline that fires and then a
  // cancel arriving from the broken stream are two events for one ending.
  let settled = false;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const settle = (outcome: StreamOutcome): void => {
    clear();
    if (settled) {
      return;
    }
    settled = true;
    onEnd({ outcome, bytes, durationMs: Date.now() - startedAt });
  };

  const arm = (
    ms: number,
    outcome: 'first_chunk_timeout' | 'idle_timeout',
    message: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      if (settled) {
        return;
      }
      const error = new StreamDeadlineError(outcome, message);
      // Report before erroring: the error propagates to the client synchronously
      // from here, and an observer should already know why.
      settle(outcome);
      // Cut the upstream first, so it stops producing, then fail the stream the
      // client is reading. Either order works; this one leaves no window in
      // which the client has given up while the upstream still bills.
      abort(error);
      controller.error(error);
    }, ms);
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        arm(
          firstChunkTimeoutMs,
          'first_chunk_timeout',
          `upstream sent no body within firstChunkTimeoutMs=${firstChunkTimeoutMs}`,
          controller,
        );
      },
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        arm(
          streamIdleTimeoutMs,
          'idle_timeout',
          `upstream body stalled for streamIdleTimeoutMs=${streamIdleTimeoutMs}`,
          controller,
        );
        controller.enqueue(chunk);
      },
      flush() {
        settle('complete');
      },
      cancel(reason) {
        // Two very different endings arrive here. The client closing its tab
        // cancels the readable side; an upstream connection that failed cancels
        // it too, with the runtime's error as the reason. `AbortError` is the
        // client — verified in workerd, a client abort surfaces under that name —
        // and anything else is the connection.
        const name = reason instanceof Error ? reason.name : '';
        settle(name === '' || name === 'AbortError' ? 'client_closed' : 'upstream_reset');
      },
    }),
  );
};

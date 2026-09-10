/**
 * Named timing presets for routes whose upstream does not behave like an
 * ordinary web server.
 *
 * These are **one-shot templates**, not live references: copying the numbers
 * into a route is the whole mechanism. Nothing in the config schema points at
 * a preset, and nothing here is read at request time — the admin panel fills
 * form fields from this table, and hand-written JSON copies it from the README
 * (a unit test fails when the two drift). A preset stays ordinary numbers the
 * moment it lands, so a route that outgrows one edits it like any other route.
 *
 * Every preset names only the fields it means to move; the unnamed timing
 * fields keep their schema defaults. `llm` and `streaming` split that way on
 * purpose — the header deadlines and the body deadlines fail for different
 * reasons, so a route that is both an LLM upstream and a token stream applies
 * both.
 */
export const TIMING_PRESETS = {
  /**
   * For an upstream that thinks before answering: OpenAI-style APIs, a
   * cold-starting Hugging Face Space. 90s of header patience covers a cold
   * start; the total is set above the per-attempt so the one retry the preset
   * asks for actually fits inside the budget; `retries: 1` rides out a single
   * transient 502 from a waking container (and only ever fires for idempotent
   * methods — a `POST` body cannot be replayed).
   */
  llm: {
    timeoutMs: 90_000,
    totalTimeoutMs: 120_000,
    retries: 1,
  },
  /**
   * For a response that streams tokens for minutes. The body deadlines are the
   * only fields it moves: headers arrive on ordinary web time, but a reasoning
   * model can sit minutes before its first token, and minutes of on-topic
   * silence between tokens is normal, not a dead connection.
   */
  streaming: {
    firstChunkTimeoutMs: 180_000,
    streamIdleTimeoutMs: 180_000,
  },
  /**
   * For a stream that must not cost CPU per chunk: the plan-metered free tier.
   * Both body deadlines at `0` takes the monitor off the body entirely — the
   * response is relayed natively and the per-chunk CPU bill reads zero, which
   * is the only mode a long token stream survives the free plan's 10 ms
   * ceiling in. The costs are the mirror: a stalled stream cuts itself off
   * nowhere (the client waits on its own timeout), and there is no
   * `proxy_stream` observability line for the response. A route mirroring
   * bodies or rewriting them keeps its script pipeline regardless.
   */
  passthrough: {
    firstChunkTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
  },
} as const;

export type TimingPresetName = keyof typeof TIMING_PRESETS;
export type TimingPreset = (typeof TIMING_PRESETS)[TimingPresetName];

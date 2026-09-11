/**
 * Named timing presets for routes whose upstream does not behave like an
 * ordinary web server.
 *
 * These are **one-shot templates**, not live references: copying the numbers
 * into a route is the whole mechanism. Nothing in the config schema points at a
 * preset, and nothing here is read at request time — the admin panel fills
 * form fields from this table, and hand-written JSON copies it from the README
 * (a unit test fails when the two drift). A preset stays ordinary numbers the
 * moment it lands, so a route that outgrows one edits it like any other route.
 *
 * Presets are assembled per scenario, not per axis: a real route needs a header
 * deadline *and* a body policy at once, and a preset that sets only one leaves
 * the other at its schema default — which is how a passthrough route once died
 * at the default 10s header deadline before its body was ever reached. One
 * button, every timing field the scenario needs.
 */
export const TIMING_PRESETS = {
  /**
   * The monitored LLM gateway: patient headers plus watched body. 90s of
   * header patience covers a cold-starting Hugging Face Space or a model
   * thinking before answering; the total is set above the per-attempt so the
   * one retry the preset asks for actually fits inside the budget; the body
   * deadlines stay generous because a reasoning model can sit minutes before
   * its first token, and minutes of on-topic silence between tokens is
   * normal, not a dead connection. Choose this where the free plan's CPU
   * ceiling is not in play and the observability of `proxy_stream` lines is
   * worth keeping.
   */
  llm: {
    timeoutMs: 90_000,
    totalTimeoutMs: 120_000,
    retries: 1,
    firstChunkTimeoutMs: 180_000,
    streamIdleTimeoutMs: 180_000,
  },
  /**
   * The plan-metered free tier's answer to the same scenario: same patient
   * headers, but both body deadlines at `0` takes the monitor off the body
   * entirely — the response is relayed natively and the per-chunk CPU bill
   * reads zero, which is the only mode a long token stream survives the free
   * plan's 10 ms ceiling in. The costs are the mirror: a stalled stream cuts
   * itself off nowhere (the client waits on its own timeout), and there is no
   * `proxy_stream` observability line for the response. A route mirroring
   * bodies or rewriting them keeps its script pipeline regardless.
   */
  passthrough: {
    timeoutMs: 90_000,
    totalTimeoutMs: 120_000,
    retries: 1,
    firstChunkTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
  },
} as const;

export type TimingPresetName = keyof typeof TIMING_PRESETS;
export type TimingPreset = (typeof TIMING_PRESETS)[TimingPresetName];

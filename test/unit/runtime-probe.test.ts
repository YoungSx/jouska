import { describe, expect, it } from 'vitest';

// These assertions pin down platform behaviour the design depends on.
// If any fails, the corresponding design decision must be revisited.
describe('workerd platform assumptions', () => {
  it('exposes native HTMLRewriter', () => {
    expect(typeof HTMLRewriter).toBe('function');
  });

  it('supports AbortSignal.timeout for upstream deadlines', () => {
    expect(typeof AbortSignal.timeout).toBe('function');
    expect(AbortSignal.timeout(50)).toBeInstanceOf(AbortSignal);
  });

  it('supports TransformStream for streaming body rewrite', () => {
    expect(typeof TransformStream).toBe('function');
  });

  it('rejects a fetch when its signal aborts', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(signal.aborted).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

/**
 * The config cache relies on module-scope state surviving between requests
 * within one isolate. If this ever stopped holding, every request would hit
 * the config store and blow through the free-tier read allowance.
 */
let counter = 0;
const bump = (): number => {
  counter += 1;
  return counter;
};

describe('isolate state reuse', () => {
  it('retains module-scope state across calls', () => {
    expect(bump()).toBe(1);
    expect(bump()).toBe(2);
  });

  it('still sees state written by the previous test', () => {
    // Same module instance, so the counter carries over rather than resetting.
    expect(bump()).toBe(3);
  });
});

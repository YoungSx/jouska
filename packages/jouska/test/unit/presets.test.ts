import { describe, expect, it } from 'vitest';
import { TIMING_PRESETS } from '../../src/presets';
import { defineConfig } from '../../src/config';

describe('TIMING_PRESETS', () => {
  it('stays inside the schema bounds it claims to fill', () => {
    // A route carrying every preset field at once is the union a panel user
    // can produce by applying both presets; it must validate outright.
    const merged = Object.fromEntries(
      Object.values(TIMING_PRESETS).flatMap((preset) => Object.entries(preset)),
    );
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', ...merged }] }),
    ).not.toThrow();
  });
});

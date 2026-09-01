/**
 * Request body parsing: every JSON endpoint wants "an object, or nothing".
 * Collapsing parse failures, arrays and non-objects to `{}` (whose fields are
 * then `undefined`) keeps handlers uniform without try/catch in each one.
 *
 * Arrays matter here: `typeof [] === 'object'`, so an array body would
 * otherwise reach a handler as a body whose named fields are all undefined —
 * indistinguishable from `{}` but with a `length`. `isPlainObject` excludes it.
 */
import type { Context } from 'hono';
import { isPlainObject } from './validate.js';

export const readJsonObject = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await c.req.json();
    return isPlainObject(body) ? body : {};
  } catch {
    return {};
  }
};

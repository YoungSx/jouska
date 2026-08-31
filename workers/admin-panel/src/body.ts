/**
 * Request body parsing: every JSON endpoint wants "an object, or nothing".
 * Collapsing parse failures and non-object bodies to `{}` (whose fields are
 * then `undefined`) keeps handlers uniform without try/catch in each one.
 */
import type { Context } from 'hono';

export const readJsonObject = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

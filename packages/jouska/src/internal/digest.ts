/**
 * SHA-256 hex digest.
 *
 * Its own file with zero imports for one reason: the admin panel needs the exact
 * same function. `access.keys` stores digests, and the panel is where an operator
 * generates a key and pastes the digest in — if the two sides ever computed the
 * digest differently, every generated key would be silently rejected at the edge.
 *
 * The panel cannot import the library's entry point (it resolves to `dist` and
 * pulls in workers-types, which the panel's tsc does not have), so it aliases this
 * single file the same way it already aliases `presets.ts`. One implementation,
 * two consumers, no copy to keep in sync.
 */

const encoder = new TextEncoder();

/** Lower-case hex, 64 characters. The format `access.keys` is validated against. */
export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

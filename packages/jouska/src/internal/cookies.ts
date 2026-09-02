/**
 * Reads one cookie's value from a raw `Cookie` header.
 *
 * Shared between the sticky-split assignment and route matching so there is one
 * parser, not two that drift: a name `selection` finds and `matchUrl` misses is
 * a config that behaves differently depending on which code path read it.
 *
 * Returns `undefined` when the name is absent and `''` when it is present with
 * an empty value (`beta=`) — presence is not the same as having a value, and
 * `match.cookies` `present` has to distinguish the two.
 */
export const readCookie = (header: string, name: string): string | undefined => {
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (pair.slice(0, eq).trim() === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
};

/**
 * Danger classification for route fields.
 *
 * The panel's job is not to forbid these — every one is legitimate — but to
 * make the operator's finger heavier: the API flags them, the UI asks twice.
 */

export interface FieldRisk {
  /** Dot path into the route definition, e.g. `allowPrivateUpstream`. */
  readonly path: string;
  readonly level: 'high' | 'medium';
  readonly reason: string;
}

/**
 * Classification per dot-path. Looked up by walking the definition, so a
 * nested hit (`bodyRewrite.fallbackCharset`) is reported with its full path.
 */
const RULES: readonly FieldRisk[] = [
  {
    path: 'allowPrivateUpstream',
    level: 'high',
    reason:
      'permits loopback, private and cloud-metadata upstreams — one corrupted value turns the proxy into an internal network probe',
  },
  {
    path: 'scheme',
    level: 'medium',
    reason: 'http forwards traffic unencrypted between the edge and the upstream',
  },
  {
    path: 'cors.origins',
    level: 'medium',
    reason:
      'omitting origins reflects any caller origin, letting other sites read credentialed responses through this proxy',
  },
  {
    path: 'bodyRewrite.contentTypes',
    level: 'medium',
    reason:
      'rewriting applies to whatever types are listed — a broad list rewrites non-text bodies into corruption',
  },
  {
    path: 'bodyRewrite.fallbackCharset',
    level: 'medium',
    reason:
      'decoding a body in the wrong charset mangles it; the wrong guess is worse than no rewrite',
  },
  {
    path: 'ip.allow',
    level: 'medium',
    reason: 'an allow-list with a typo silently admits the addresses it was meant to exclude',
  },
  {
    path: 'ip.deny',
    level: 'medium',
    reason: 'a deny-list with a typo silently excludes legitimate callers',
  },
  {
    path: 'upstreamHeaders',
    level: 'high',
    reason:
      'injected headers reach the upstream verbatim — credential or impersonation headers here are forwarded to a third party',
  },
];

/**
 * Returns every rule whose dot-path exists in `definition`, with the concrete
 * path where it was found. `cors.origins` is special: only flagged when the
 * field is *absent*, because presence is exactly what makes it safe.
 */
export const dangerFlags = (definition: Record<string, unknown>): FieldRisk[] => {
  const flags: FieldRisk[] = [];
  for (const rule of RULES) {
    const segments = rule.path.split('.');
    let node: unknown = definition;
    let found = true;
    // Walk every segment; the path only exists if all of them do.
    for (const segment of segments) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        found = false;
        break;
      }
      node = (node as Record<string, unknown>)[segment];
      if (node === undefined) {
        found = false;
        break;
      }
    }
    if (rule.path === 'cors.origins') {
      // Absence is the dangerous state, and only when cors is configured at
      // all — no cors means no CORS behaviour to widen.
      if (definition['cors'] !== undefined && !found) {
        flags.push({ ...rule, path: 'cors.origins (absent)' });
      }
      continue;
    }
    if (found) {
      flags.push(rule);
    }
  }
  return flags;
};

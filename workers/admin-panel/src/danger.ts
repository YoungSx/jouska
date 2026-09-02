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
 * Value guard for a rule. Absent means "the field's existence is the risk";
 * present, the rule only fires when the stored value also qualifies — `scheme`
 * is the case in point, where `https` written out is a deliberate statement,
 * not a risk, and flagging it makes the publish dialog lie about the config.
 */
type ValueGuard = (node: unknown) => boolean;

/**
 * Classification per dot-path. Looked up by walking the definition, so a
 * nested hit (`bodyRewrite.fallbackCharset`) is reported with its full path.
 * The `guard` is internal classification data and never leaks into a FieldRisk.
 */
type Rule = FieldRisk & { guard?: ValueGuard };

const RULES: readonly Rule[] = [
  {
    path: 'allowPrivateUpstream',
    level: 'high',
    reason:
      'permits loopback, private and cloud-metadata upstreams — one corrupted value turns the proxy into an internal network probe',
  },
  {
    path: 'scheme',
    level: 'medium',
    // Only `http` is the risk; `https` is the default spelled out and must not
    // raise a false warning on publish.
    guard: (node) => node === 'http',
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
    path: 'access.keys',
    level: 'medium',
    reason:
      'a pasted value that is not the SHA-256 digest of the real key permanently locks out the real key and admits whoever the pasted text names — verify the digest, not the key',
  },
  {
    path: 'upstreamHeaders',
    level: 'high',
    reason:
      'injected headers reach the upstream verbatim — credential or impersonation headers here are forwarded to a third party',
  },
  {
    // The same field under its current name: `upstreamHeaders` is an alias for
    // this one, so both spellings have to carry the same warning.
    path: 'requestHeaders.set',
    level: 'high',
    reason:
      'injected headers reach the upstream verbatim — credential or impersonation headers here are forwarded to a third party',
  },
  {
    path: 'requestHeaders.remove',
    level: 'medium',
    reason:
      'removing cookie or authorization makes upstream sessions and authentication fail with nothing said about why',
  },
  {
    path: 'responseHeaders.set',
    level: 'medium',
    reason:
      'these run after the proxy rewrote the response, so a rule can point Location back at the upstream, restore a CSP that blocks the rewritten page from loading its own assets, or restore a validator that makes the client serve the unrewritten body from its own cache',
  },
  {
    path: 'cache.contentTypes',
    level: 'medium',
    reason:
      'the default list is static assets only; adding a document type means a page personalised without a cookie or a private marker would be served to the next visitor',
  },
  {
    path: 'cache.key.headers',
    level: 'medium',
    // An empty list folds nothing and is the default spelled out.
    guard: (node) => Array.isArray(node) && node.length > 0,
    reason:
      'every distinct value of these headers becomes its own cache entry — folding a high-cardinality header like user-agent or referer gives each visitor a private cache and the hit rate drops to zero',
  },
  {
    // Only the plaintext scheme is the risk, exactly like `scheme` — an https
    // auth endpoint deserves no warning on publish.
    path: 'forwardAuth.url',
    level: 'medium',
    guard: (node) => typeof node === 'string' && node.startsWith('http://'),
    reason:
      'http sends the copied credentials (authorization, cookie) unencrypted to the auth endpoint',
  },
  {
    path: 'forwardAuth.failOpen',
    level: 'high',
    reason:
      'an unreachable auth endpoint then admits everything — availability outranks admission, so an outage becomes open doors',
  },
  {
    // The whole block, not a subfield: a mistyped team or audience admits nobody,
    // and the failure looks like an outage rather than a config error.
    path: 'accessJwt',
    level: 'medium',
    reason:
      'a wrong team or audience refuses correctly signed requests with 401 — the lockout reads as an outage, not a typo',
  },
  {
    path: 'apiKey.keys',
    level: 'high',
    reason:
      'anyone who can edit this table can mint themselves a working key — a digest is not an authorisation',
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
    if (found && rule.guard !== undefined && !rule.guard(node)) {
      found = false;
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
      // Strip the guard: it is classification input, not reportable data.
      const { guard: _guard, ...risk } = rule;
      flags.push(risk);
    }
  }
  return flags;
};

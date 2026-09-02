/**
 * Response header rewriting.
 *
 * Hop-by-hop headers are stripped on the way back, and `Location`, `Set-Cookie`,
 * `Refresh` and `Content-Location` are rewritten so the visitor stays on the
 * proxy instead of being sent to the upstream on the first redirect and losing
 * every cookie.
 */

import type { HeaderRulesConfig } from '../config.js';
import { HOP_BY_HOP, stripConnectionNamed } from './hop.js';

/**
 * Whether a host belongs to the upstream.
 *
 * The upstream host itself and anything beneath it — so an upstream of
 * `origin.test` covers `www.origin.test` and `cdn.a.origin.test`. A redirect to a
 * subdomain is the same site as far as the visitor is concerned, and leaving it
 * alone sent them straight off the proxy on the first redirect.
 *
 * It deliberately does NOT walk up to a registrable suffix. Doing that needs a
 * public-suffix list, and approximating one by taking the last two labels is
 * actively unsafe: for an upstream of `origin.co.uk` it yields a "site" of
 * `co.uk`, which then matches *every* `.co.uk` host — so an unrelated
 * `evil.co.uk` cookie would be rescoped onto the proxy and its redirects
 * hijacked. Verified against workerd before this was narrowed.
 *
 * The cost of the narrower rule is that an upstream of `www.origin.test`
 * redirecting to the apex `origin.test` is left alone. That is a visible,
 * debuggable miss — point the route at the apex, or add the sibling as its own
 * route — rather than a silent over-reach.
 */
export const upstreamHostMatcher = (upstreamHost: string): ((host: string) => boolean) => {
  const bare = upstreamHost.split(':')[0]!.toLowerCase().replace(/\.$/, '');
  const suffix = `.${bare}`;
  return (host: string): boolean => {
    const candidate = host.split(':')[0]!.toLowerCase().replace(/\.$/, '');
    if (candidate === bare) {
      return true;
    }
    if (!candidate.endsWith(suffix)) {
      return false;
    }
    // The part the suffix did not cover has to be one or more real labels.
    // `endsWith` alone accepted `.origin.test` and `..origin.test`, whose
    // leading label is empty — verified in workerd, the URL parser keeps such a
    // hostname verbatim, so it reaches this function. Treating it as a subdomain
    // would rescope its `Set-Cookie` onto the proxy and rewrite its redirects,
    // for a host the upstream's registrant does not own.
    const consumed = candidate.slice(0, candidate.length - suffix.length);
    return consumed !== '' && consumed.split('.').every((label) => label !== '');
  };
};

/** Rewrites an absolute URL onto the proxy origin when it names an upstream host. */
export const rewriteAbsoluteUrl = (
  value: string,
  isUpstreamHost: (host: string) => boolean,
  proxyOrigin: string,
): string => {
  // Relative references already stay on the proxy.
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return value;
  }
  if (!isUpstreamHost(target.host)) {
    return value;
  }
  const proxy = new URL(proxyOrigin);
  target.protocol = proxy.protocol;
  target.host = proxy.host;
  return target.toString();
};

/** Rewrites an upstream `Location` back onto the proxy origin. */
export const rewriteLocation = (
  location: string,
  upstreamHost: string,
  proxyOrigin: string,
): string => rewriteAbsoluteUrl(location, upstreamHostMatcher(upstreamHost), proxyOrigin);

/**
 * Rewrites the `Domain` attribute of a `Set-Cookie` so the browser accepts it.
 *
 * Only cookies scoped to the upstream are rescoped. Rewriting every `Domain`
 * hijacked third-party cookies onto the proxy — verified: `Domain=other.test`
 * came back as `Domain=p.dev`, which both breaks that cookie and attaches a
 * value the third party set to requests it never expected to see.
 *
 * A cookie whose `Domain` names something unrelated has its attribute dropped
 * instead, which scopes it to the proxy host exactly. Leaving it in place would
 * make the browser discard the cookie outright.
 */
export const rewriteSetCookie = (
  cookie: string,
  proxyHost: string,
  isUpstreamHost: (host: string) => boolean,
): string => {
  const attrs = cookie.split(';');
  const rewritten = attrs.map((attr, index): string | undefined => {
    // Index 0 is the cookie name/value pair, never an attribute: a cookie
    // literally named `domain` must survive untouched.
    if (index === 0) {
      return attr;
    }
    const eq = attr.indexOf('=');
    if (eq === -1) {
      return attr;
    }
    const name = attr.slice(0, eq);
    if (name.trim().toLowerCase() !== 'domain') {
      return attr;
    }
    // Preserve the original leading whitespace to keep the header tidy.
    const lead = name.slice(0, name.length - name.trimStart().length);
    // A leading dot is the legacy "and subdomains" form; strip it before comparing.
    const domain = attr
      .slice(eq + 1)
      .trim()
      .replace(/^\./, '');
    if (!isUpstreamHost(domain)) {
      // Not ours to rescope. Marked for removal rather than pointed at the
      // proxy: the cookie then becomes host-only, which is the narrowest scope
      // that still works and does not claim a domain the upstream never owned.
      return undefined;
    }
    return `${lead}Domain=${proxyHost}`;
  });
  return rewritten.filter((attr) => attr !== undefined).join(';');
};

export interface RewriteHeadersOptions {
  headers: Headers;
  upstreamHost: string;
  proxyOrigin: string;
  /** True when the body will be rewritten, which invalidates the validators. */
  bodyRewritten: boolean;
}

export interface RewrittenHeaders {
  readonly headers: Headers;
  /**
   * True when the `Location` handed to the client differs from the one the
   * upstream sent.
   *
   * Defined as that difference rather than as "the host belonged to the
   * upstream", because the difference is what a visitor experiences and what an
   * operator can check. `Content-Location` and `Refresh` are rewritten by the
   * same pass but do not count here: neither navigates, and folding them in
   * would make a true value stop meaning "the redirect stayed on the proxy".
   */
  readonly redirectRewritten: boolean;
}

/**
 * Rewrites a response's headers, returning a new `Headers` alongside the one
 * conclusion a caller cannot recover from the result: whether the redirect was
 * actually pointed back at the proxy.
 *
 * `Set-Cookie` is enumerated with `getSetCookie()` so multiple cookies survive
 * being read back.
 */
export const rewriteResponseHeaders = ({
  headers,
  upstreamHost,
  proxyOrigin,
  bodyRewritten,
}: RewriteHeadersOptions): RewrittenHeaders => {
  const out = stripHopByHop(headers);
  const proxy = new URL(proxyOrigin);
  const isUpstreamHost = upstreamHostMatcher(upstreamHost);

  let redirectRewritten = false;
  for (const name of ['location', 'content-location'] as const) {
    const value = out.get(name);
    if (value !== null) {
      const rewritten = rewriteAbsoluteUrl(value, isUpstreamHost, proxyOrigin);
      out.set(name, rewritten);
      if (name === 'location' && rewritten !== value) {
        redirectRewritten = true;
      }
    }
  }

  // `Refresh: 3; url=...` is the header form of a meta refresh. Non-standard but
  // widely honoured, so leaving it would walk the visitor off the proxy.
  const refresh = out.get('refresh');
  if (refresh !== null) {
    out.set(
      'refresh',
      refresh.replace(
        /(url\s*=\s*)(\S+)/i,
        (_, prefix: string, target: string) =>
          `${prefix}${rewriteAbsoluteUrl(target, isUpstreamHost, proxyOrigin)}`,
      ),
    );
  }

  const cookies = out.getSetCookie();
  if (cookies.length > 0) {
    out.delete('set-cookie');
    for (const cookie of cookies) {
      out.append('set-cookie', rewriteSetCookie(cookie, proxy.hostname, isUpstreamHost));
    }
  }

  if (bodyRewritten) {
    stripBodyValidators(out);
  }
  return { headers: out, redirectRewritten };
};

/**
 * Copies headers, dropping the ones that describe a single connection.
 *
 * Also drops `content-encoding` and, with it, `content-length`. Requests go out
 * without `accept-encoding`, and the Workers runtime decompresses what it does
 * understand and removes the header itself, so by the time a response reaches
 * here an encoding label should not have survived.
 *
 * The limit of that reasoning, recorded rather than papered over: if one does
 * survive, the bytes are relayed as they arrived and the label is removed, so a
 * client is handed encoded bytes with nothing saying so. Verified only with an
 * injected `fetchImpl` — brotli-labelled bytes came back byte-identical and
 * unlabelled — which is reachable through the `fetchImpl` option and, in
 * principle, through an encoding the runtime passes through verbatim. It has not
 * been reproduced against a real origin, so the fix is not guessed at here:
 * relaying the label instead would be wrong whenever the upstream declared an
 * encoding it had not applied, which is the case this drop was written for.
 */
export const stripHopByHop = (headers: Headers): Headers => {
  const out = new Headers(headers);
  if (out.has('content-encoding')) {
    out.delete('content-encoding');
    // The length described the encoded form, so it no longer applies.
    out.delete('content-length');
  }
  stripConnectionNamed(out);
  for (const name of HOP_BY_HOP) {
    out.delete(name);
  }
  return out;
};

/**
 * Removes the headers that describe the body the upstream sent, once that body
 * is no longer what the client will receive.
 *
 * `content-length` is obvious. The validators are the subtle half: keeping the
 * upstream's `etag` means the client's next request carries `If-None-Match`, the
 * upstream answers 304, and the client then serves the *unrewritten* body from
 * its own cache — the rewrite silently undone on every subsequent visit. nginx's
 * `sub_filter` clears both for the same reason.
 */
export const stripBodyValidators = (headers: Headers): void => {
  headers.delete('content-length');
  headers.delete('etag');
  headers.delete('last-modified');
  headers.delete('digest');
  headers.delete('content-digest');
  headers.delete('repr-digest');
  // Length and integrity no longer describe what is sent.
  headers.delete('content-md5');
  // A CSP from the upstream names its own origin in directives like `img-src` or
  // `connect-src`. Once links are rewritten onto the proxy, those rules block
  // the page from loading its own rewritten resources. Rewriting CSP is a
  // separate grammar with its own footguns, so it is dropped rather than
  // half-fixed: the proxy has already taken responsibility for the body's URLs.
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
};

/**
 * Applies the operator's declarative response rules.
 *
 * Runs **last**, after every rewrite this module and the middleware perform, so a
 * rule can override the proxy's own result. That is a deliberate trade-off with a
 * sharp edge: `responseHeaders.set` can put an upstream URL back into `Location`
 * and send the visitor off the proxy. It is documented in the README's header
 * rules section and flagged by the admin panel rather than prevented here, because
 * the alternative — running the operator's rules first — makes every one of them
 * silently unreliable, which is worse for a value someone wrote on purpose.
 *
 * Deletion is refused by the schema for the headers the proxy rewrote, so a rule
 * cannot make a redirect vanish or a login silently fail by tidying up.
 *
 * Deletions run before writes for the same reason as on the request side: the
 * schema refuses a name in both, so the order is not observable, and "clear it,
 * then write it" is the reading that survives if that relaxes.
 */
export const applyResponseHeaderRules = (
  headers: Headers,
  rules: HeaderRulesConfig | undefined,
): void => {
  if (rules === undefined) {
    return;
  }
  for (const name of rules.remove) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(rules.set)) {
    headers.set(name, value);
  }
};

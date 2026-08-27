/**
 * Response header rewriting.
 *
 * Hop-by-hop headers are stripped on the way back, and `Location`, `Set-Cookie`,
 * `Refresh` and `Content-Location` are rewritten so the visitor stays on the
 * proxy instead of being sent to the upstream on the first redirect and losing
 * every cookie.
 */

/** Hop-by-hop headers describe one connection and must not be relayed. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
] as const;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
  return (host: string): boolean => {
    const candidate = host.split(':')[0]!.toLowerCase().replace(/\.$/, '');
    return candidate === bare || candidate.endsWith(`.${bare}`);
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

/**
 * Rewrites a response's headers, returning a new `Headers`.
 *
 * `Set-Cookie` is enumerated with `getSetCookie()` so multiple cookies survive
 * being read back.
 */
export const rewriteResponseHeaders = ({
  headers,
  upstreamHost,
  proxyOrigin,
  bodyRewritten,
}: RewriteHeadersOptions): Headers => {
  const out = stripHopByHop(headers);
  const proxy = new URL(proxyOrigin);
  const isUpstreamHost = upstreamHostMatcher(upstreamHost);

  for (const name of ['location', 'content-location'] as const) {
    const value = out.get(name);
    if (value !== null) {
      out.set(name, rewriteAbsoluteUrl(value, isUpstreamHost, proxyOrigin));
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
  return out;
};

/**
 * Copies headers, dropping the ones that describe a single connection.
 *
 * Also drops `content-encoding` and, with it, `content-length`. Requests go out
 * without `accept-encoding`, so a body should arrive uncompressed; an upstream
 * that declares an encoding anyway is describing something the client is not
 * receiving, and a client that believes it would fail to decode the response.
 */
export const stripHopByHop = (headers: Headers): Headers => {
  const out = new Headers(headers);
  if (out.has('content-encoding')) {
    out.delete('content-encoding');
    // The length described the encoded form, so it no longer applies.
    out.delete('content-length');
  }
  const connection = out.get('connection');
  if (connection !== null) {
    for (const name of connection.split(',')) {
      const trimmed = name.trim();
      if (TOKEN.test(trimmed)) {
        out.delete(trimmed);
      }
    }
  }
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

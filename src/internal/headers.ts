/**
 * Response header rewriting. `hono/proxy` strips hop-by-hop headers but leaves
 * `Location` and `Set-Cookie` pointing at the upstream, which would send the
 * visitor off the proxy on the first redirect and drop every cookie.
 */

/** Rewrites an upstream `Location` back onto the proxy origin. */
export const rewriteLocation = (
  location: string,
  upstreamHost: string,
  proxyOrigin: string,
): string => {
  // Relative locations already stay on the proxy.
  if (!/^https?:\/\//i.test(location)) {
    return location;
  }
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return location;
  }
  if (target.host !== upstreamHost) {
    return location;
  }
  const proxy = new URL(proxyOrigin);
  target.protocol = proxy.protocol;
  target.host = proxy.host;
  return target.toString();
};

/**
 * Rewrites the `Domain` attribute of a `Set-Cookie` so the browser accepts it.
 * A cookie scoped to the upstream domain is silently discarded by the client.
 */
export const rewriteSetCookie = (cookie: string, proxyHost: string): string => {
  const attrs = cookie.split(';');
  const rewritten = attrs.map((attr, index) => {
    // Index 0 is the cookie name/value pair, never an attribute: a cookie
    // literally named `domain` must survive untouched.
    if (index === 0) {
      return attr;
    }
    const [name, ...rest] = attr.split('=');
    if (name === undefined || rest.length === 0 || name.trim().toLowerCase() !== 'domain') {
      return attr;
    }
    // Preserve the original leading whitespace to keep the header tidy.
    const lead = name.slice(0, name.length - name.trimStart().length);
    return `${lead}Domain=${proxyHost}`;
  });
  return rewritten.join(';');
};

/**
 * Applies both rewrites to a response's headers, returning a new Headers.
 * `Set-Cookie` is enumerated with `getSetCookie()` so multiple cookies survive.
 */
export const rewriteResponseHeaders = (
  headers: Headers,
  upstreamHost: string,
  proxyOrigin: string,
): Headers => {
  const out = new Headers(headers);
  const proxyHost = new URL(proxyOrigin).hostname;

  const location = out.get('location');
  if (location !== null) {
    out.set('location', rewriteLocation(location, upstreamHost, proxyOrigin));
  }

  const cookies = out.getSetCookie();
  if (cookies.length > 0) {
    out.delete('set-cookie');
    for (const cookie of cookies) {
      out.append('set-cookie', rewriteSetCookie(cookie, proxyHost));
    }
  }
  return out;
};

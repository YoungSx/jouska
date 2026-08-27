/**
 * Hop-by-hop header constants shared by request and response paths.
 *
 * Keeping a single copy of the list prevents the two directions from silently
 * diverging: change one, forget the other, and request/response stripping
 * drifts apart with no test catching it.
 */

/**
 * Hop-by-hop headers, which describe a single connection and must not be
 * forwarded (RFC 9110 §7.6.1).
 *
 * `upgrade` is absent deliberately: a WebSocket handshake needs it to reach the
 * upstream, and Workers terminates the connection itself, so forwarding it is
 * how the upgrade is proxied at all rather than a protocol violation. It is
 * removed explicitly when the route has `websocket: false`.
 */
export const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
] as const;

/** A header name is a token; anything else could smuggle a second header. */
export const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Drops headers named in the `connection` header.
 *
 * A client- or server-supplied `Connection` header names further headers to
 * drop. Honouring it before stripping prevents a smuggled
 * `Connection: X-Secret` from surviving: once the named header is deleted here,
 * the subsequent hop-by-hop sweep cleans up `connection` itself.
 *
 * Each name is validated against `TOKEN` so a malformed value cannot be used to
 * delete arbitrary headers by injecting non-token characters.
 */
export const stripConnectionNamed = (headers: Headers): void => {
  const connection = headers.get('connection');
  if (connection === null) {
    return;
  }
  for (const name of connection.split(',')) {
    const trimmed = name.trim();
    if (TOKEN.test(trimmed)) {
      headers.delete(trimmed);
    }
  }
};

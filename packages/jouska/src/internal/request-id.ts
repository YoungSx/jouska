import type { Route } from '../config.js';

/**
 * The header the request ID travels under, on all three legs of one request:
 * read from the client when `requestId.trustInbound` is on, stamped onto the
 * upstream request, and stamped onto the response the client receives.
 *
 * A constant rather than a config field, deliberately: the refusal of
 * `x-request-id` in `requestHeaders` is a parse-time check against a fixed set
 * (`RESERVED_REQUEST_HEADERS`). A per-route name would move that check into
 * cross-field validation that has to survive `defaults` folding, to buy a knob
 * nothing calls for.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * What an ID is allowed to look like.
 *
 * `cf-ray` (hex, a dash, a point-of-presence code) fits with room to spare, and
 * so does a UUID. Anything outside the class is refused wholesale rather than
 * escaped: a newline or a control character reaching a JSON log line is log
 * injection, and repairing a hostile value produces an ID nobody else is
 * logging.
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Resolves the one ID a proxied request is identified by — on the upstream
 * request, the client's response and the proxy event.
 *
 * Precedence, least-surprising first:
 *
 * 1. the caller's value, but only when the route opted into `trustInbound` and
 *    the value has the shape above — a malformed one is discarded, not repaired,
 *    so the log line this lands in stays valid JSON and the ID stays something
 *    the next hop would have produced itself;
 * 2. `cf-ray`, which the edge puts on every request it hands the Worker and
 *    which already matches Cloudflare's own request logs — adopting it costs
 *    nothing and correlates for free;
 * 3. a random UUID, for requests with no platform value: a local fetch in
 *    tests, or this middleware running outside the edge.
 */
export const resolveRequestId = (route: Route, request: Request): string => {
  if (route.requestId?.trustInbound === true) {
    // The optional chain is not a shortcut around the schema: a route handed
    // over as a hand-written object can be missing the block entirely, and
    // reading a missing block as "not trusted" is the safe reading.
    const inbound = request.headers.get(REQUEST_ID_HEADER);
    if (inbound !== null && ID_SHAPE.test(inbound)) {
      return inbound;
    }
  }
  const ray = request.headers.get('cf-ray');
  if (ray !== null && ID_SHAPE.test(ray)) {
    return ray;
  }
  return crypto.randomUUID();
};

/**
 * Stamps a resolved ID onto a header set, in place. Every header set jouska
 * stamps is mutable — a route's rules, a rebuilt cached entry, a `c.json`
 * refusal — except a fetch-produced 101, which never reaches a stamping site
 * because its headers are spent on the handshake.
 *
 * `set` rather than `append`: a caller-supplied value is not a second one to
 * keep, and two IDs on one message would be two claims about which request this
 * was.
 */
export const stampRequestId = (headers: Headers, requestId: string): void => {
  headers.set(REQUEST_ID_HEADER, requestId);
};

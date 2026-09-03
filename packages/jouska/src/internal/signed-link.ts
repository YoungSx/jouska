import type { SignedLinkConfig } from '../config.js';
import { base64UrlBytes } from './base64url.js';

/**
 * Signed links: the URL is the credential.
 *
 * The signature is an HMAC-SHA256 over the request path and the expiry, keyed
 * by a secret the proxy holds as a binding. A link therefore works for exactly
 * the path it was minted for and stops working at its `exp`, which is what a
 * shareable asset link needs and what an IP allow-list or a key header cannot
 * express — the recipient is whatever holds the link, not a known caller.
 *
 * The message is bytes, assembled to be identical on both ends: the raw
 * request path and the raw expiry digits joined by `\n`. Nothing is
 * re-serialised — no `URLSearchParams`, no decoding of what the signer wrote —
 * because any re-serialisation is a place where the issuer's bytes and the
 * verifier's bytes can disagree while both look right.
 *
 * Verification is `crypto.subtle.verify`, which is constant-time. Writing a
 * manual compare would reintroduce the timing channel for no gain, and the
 * secret never leaves the binding.
 *
 * CPU cost is one HMAC (~microseconds), but the guard runs after rate
 * limiting regardless: an unsigned flood should be billed a 429 by the cheap
 * counter, not a 403 by a WebCrypto call per request.
 */

/** Expiry clock slack, seconds. One-way: expiry only, never early acceptance. */
export const SIGNED_LINK_TOLERANCE_SECONDS = 60;

export type SignedLinkVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing_param' | 'bad_param' | 'bad_signature' | 'expired' | 'misconfigured';
    };

/** The secret the named binding holds; a non-empty string or nothing. */
const secretOf = (env: unknown, binding: string): string | undefined => {
  const value = (env as Record<string, unknown> | undefined)?.[binding];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** Expiry digits only — no sign, no separators, at most ten of them. */
const isExpiry = (value: string): boolean => /^\d{1,10}$/.test(value);

type SignedLinkReason = NonNullable<Extract<SignedLinkVerdict, { ok: false }>['reason']>;

const refused = (reason: SignedLinkReason): SignedLinkVerdict => ({ ok: false, reason });

/**
 * Verifies a signed link against the request.
 *
 * `url` is the already-parsed request URL; the path is taken verbatim from it,
 * exactly the bytes after the authority. A missing binding is
 * `misconfigured` rather than a refusal shaped like a client error: the link
 * cannot be at fault when the proxy has no key to check it with, and the
 * caller turns this verdict into a 500.
 */
export const checkSignedLink = async (
  config: SignedLinkConfig,
  url: URL,
  env: unknown,
): Promise<SignedLinkVerdict> => {
  const secret = secretOf(env, config.secretBinding);
  if (secret === undefined) {
    return refused('misconfigured');
  }
  const signature = url.searchParams.get(config.param);
  const expires = url.searchParams.get(config.expiresParam);
  if (signature === null || expires === null) {
    return refused('missing_param');
  }
  if (!isExpiry(expires)) {
    return refused('bad_param');
  }
  const message = new Uint8Array([
    ...new TextEncoder().encode(url.pathname),
    ...new TextEncoder().encode('\n'),
    ...new TextEncoder().encode(expires),
  ]);
  const raw = base64UrlBytes(signature);
  if (raw === undefined) {
    return refused('bad_signature');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify('HMAC', key, raw, message);
  if (!valid) {
    return refused('bad_signature');
  }
  // One-way tolerance: a link is still honoured for a minute past `exp`, so a
  // client whose clock reads slightly behind the proxy is not dropped
  // mid-session. It is never admitted early — `now - exp > tolerance` is not
  // the test — because an early-accepted link is a working link before its
  // audience was meant to have it, and nothing about clock skew argues for
  // that.
  const now = Date.now() / 1000;
  if (Number.parseInt(expires, 10) + SIGNED_LINK_TOLERANCE_SECONDS < now) {
    return refused('expired');
  }
  return { ok: true };
};

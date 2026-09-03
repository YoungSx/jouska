/**
 * base64url, the URL-safe alphabet JWT uses and signed links reuse.
 *
 * One place for both directions so the two cannot drift: a signature written
 * into a link by an issuer must be read back as exactly those bytes by this
 * verifier, and a padding or alphabet mismatch would show up as every link
 * being refused rather than as anything diagnosable.
 */

/**
 * Decodes one base64url segment into bytes. Translates to the alphabet `atob`
 * accepts and restores the padding it expects; malformed input returns
 * `undefined` and the caller refuses the request.
 */
export const base64UrlBytes = (segment: string): Uint8Array | undefined => {
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
};

/**
 * Encodes bytes as unpadded base64url. Unpadded because a query parameter
 * must survive a URL verbatim — `=` is the key/value separator, so a padded
 * signature would arrive truncated or escaped and never verify.
 */
export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

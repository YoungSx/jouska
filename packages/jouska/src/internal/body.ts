/**
 * Streaming body rewriting.
 *
 * Workers caps memory at 128MB regardless of plan, so buffering the whole body
 * (`await res.text()`) is not an option. Two strategies, both streaming:
 *
 *  - HTML goes through the native `HTMLRewriter`, which rewrites URL-bearing
 *    attributes without materialising the document.
 *  - Other text types go through a `TransformStream` that keeps a small tail
 *    buffer so a match straddling a chunk boundary is still replaced.
 *
 * `hono/proxy` deletes `accept-encoding` on the way out, so bodies arrive
 * uncompressed and no decoding step is needed here.
 */

export interface Replacement {
  from: string;
  to: string;
}

/** Attributes that carry a URL and therefore need rewriting. */
const URL_ATTRIBUTES = ['href', 'src', 'action', 'srcset', 'poster', 'formaction'] as const;

/**
 * Scans `input` from `start`, emitting replaced text, and stops once fewer than
 * `keep` characters remain undecided (a needle could still straddle the edge).
 * Returns the emitted text plus the raw, unprocessed remainder, so no character
 * is ever passed through the replacement table twice.
 */
const scan = (
  input: string,
  replacements: readonly Replacement[],
  keep: number,
): { emit: string; rest: string } => {
  const limit = input.length - keep;
  let out = '';
  let i = 0;

  outer: while (i < limit) {
    for (const { from, to } of replacements) {
      if (input.startsWith(from, i)) {
        out += to;
        i += from.length;
        continue outer;
      }
    }
    out += input[i];
    i += 1;
  }
  return { emit: out, rest: input.slice(i) };
};

/**
 * Replaces literal strings across a stream. A match straddling a chunk boundary
 * is still replaced: up to `maxNeedle - 1` trailing characters are held back
 * until the next chunk arrives.
 */
export const textReplaceStream = (
  replacements: readonly Replacement[],
): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  // The most that could dangle at a chunk edge: the longest needle minus one.
  const keep = Math.max(0, ...replacements.map((r) => r.from.length)) - 1;
  let carry = '';

  return new TransformStream({
    transform(chunk, controller) {
      // `stream: true` keeps multi-byte characters intact across chunks.
      const { emit, rest } = scan(
        carry + decoder.decode(chunk, { stream: true }),
        replacements,
        keep,
      );
      carry = rest;
      if (emit !== '') {
        controller.enqueue(encoder.encode(emit));
      }
    },
    flush(controller) {
      const { emit } = scan(carry + decoder.decode(), replacements, 0);
      if (emit !== '') {
        controller.enqueue(encoder.encode(emit));
      }
    },
  });
};

/** True when the content type is one we are willing to rewrite. */
export const shouldRewrite = (contentType: string | null, allowed: readonly string[]): boolean => {
  if (contentType === null) {
    return false;
  }
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return allowed.some((a) => type.startsWith(a.toLowerCase()));
};

/**
 * Rewrites URL attributes whose host is `upstreamHost` to point at the proxy.
 * Text nodes are left alone: attribute rewriting is what keeps navigation on
 * the proxy, and touching text risks corrupting inline scripts.
 */
export const htmlRewriter = (upstreamHost: string, proxyHost: string): HTMLRewriter => {
  const rewriteValue = (value: string): string => {
    if (value.includes(upstreamHost)) {
      return value.split(upstreamHost).join(proxyHost);
    }
    return value;
  };

  return new HTMLRewriter().on('*', {
    element(element) {
      for (const attribute of URL_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value !== null) {
          const rewritten = rewriteValue(value);
          if (rewritten !== value) {
            element.setAttribute(attribute, rewritten);
          }
        }
      }
    },
  });
};

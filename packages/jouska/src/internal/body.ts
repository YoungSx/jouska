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
 * Bodies arrive uncompressed because `accept-encoding` is dropped on the way out.
 */

export interface Replacement {
  from: string;
  to: string;
}

/**
 * Attributes that carry one URL.
 *
 * `srcset` and `imagesrcset` hold a comma-separated candidate list, and `ping` a
 * space-separated one, but every entry in them is still a URL, so the same
 * host-swap applies to the whole value.
 */
const URL_ATTRIBUTES = [
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'srcset',
  'imagesrcset',
  'data',
  'cite',
  'ping',
  'background',
  'longdesc',
  'usemap',
  'manifest',
] as const;

/**
 * Scans `input` from the start, emitting replaced text, and stops once fewer
 * than `keep` characters remain undecided (a needle could still straddle the
 * edge). Returns the emitted text plus the raw, unprocessed remainder, so no
 * character is ever passed through the replacement table twice.
 *
 * Uses `indexOf` to jump between candidate positions rather than testing every
 * character: measured on a 504KB body, character-by-character scanning cost 30ms
 * of CPU against a 10ms-per-request limit on the free plan, while the jumping
 * form cost 3ms for byte-identical output.
 */
export const scan = (
  input: string,
  replacements: readonly Replacement[],
  keep: number,
): { emit: string; rest: string } => {
  const limit = input.length - keep;
  if (limit <= 0 || replacements.length === 0) {
    return { emit: input.slice(0, Math.max(0, limit)), rest: input.slice(Math.max(0, limit)) };
  }

  // One cursor per needle, advanced lazily: each is the next position at or
  // after `i` where that needle occurs, or -1 once it no longer appears.
  const next = replacements.map((r) => input.indexOf(r.from));
  const pieces: string[] = [];
  let i = 0;

  for (;;) {
    // Earliest match wins; ties go to the earlier rule, matching the previous
    // first-rule-wins behaviour so `{a→b, b→c}` never turns `a` into `c`.
    let bestAt = -1;
    let bestRule = -1;
    for (let r = 0; r < next.length; r += 1) {
      let at = next[r]!;
      if (at !== -1 && at < i) {
        // The cursor is behind the write head; re-seek from the current point.
        at = input.indexOf(replacements[r]!.from, i);
        next[r] = at;
      }
      if (at !== -1 && at < limit && (bestAt === -1 || at < bestAt)) {
        bestAt = at;
        bestRule = r;
      }
    }
    if (bestAt === -1) {
      break;
    }
    const rule = replacements[bestRule]!;
    pieces.push(input.slice(i, bestAt), rule.to);
    i = bestAt + rule.from.length;
  }

  pieces.push(input.slice(i, limit));
  return { emit: pieces.join(''), rest: input.slice(Math.max(i, limit)) };
};

/**
 * Rewrites absolute URLs in arbitrary text, resolving each candidate rather than
 * substituting the host as a substring.
 *
 * The HTML path parses attribute values, so a lookalike host is safe there. Text
 * bodies had no equivalent: passing `{from: upstreamHost, to: proxyHost}` to the
 * replacement table rewrote `https://o.test.evil.com/b` inside a stylesheet or a
 * script into `https://p.dev.evil.com/b` — verified — which both breaks the URL
 * and puts the proxy's own name inside a domain someone else controls.
 *
 * The pattern deliberately matches only scheme-qualified and protocol-relative
 * references. A bare hostname in prose or an identifier is left alone, which
 * matches what the HTML path does with text nodes.
 */
/**
 * Longest authority worth waiting for: a 253-character hostname (RFC 1035) plus
 * `https://` and a five-digit port. Past this the text cannot become a valid
 * authority, so holding it back would only grow the buffer.
 */
const MAX_AUTHORITY = 253 + 'https://'.length + ':65535'.length;

export const rewriteTextUrls = (
  text: string,
  isUpstreamHost: (host: string) => boolean,
  proxyHost: string,
): { rewritten: string; rest: string } => {
  const pattern = /(https?:)?\/\/[a-z0-9.-]*(:\d{0,5})?/gi;
  const pieces: string[] = [];
  let cursor = 0;

  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const match = m[0];
    const end = m.index + match.length;
    // A reference touching the end of the buffer may continue into what has not
    // arrived. Judging it now would compare a truncated host — a buffer ending
    // mid-way through `o.test.evil.com` looks exactly like `o.test`, and
    // rewriting it would recreate the lookalike hole that parsing each candidate
    // exists to close. Emit what precedes it and hand the reference back.
    if (end === text.length) {
      // Unless it is already too long to become a valid authority. Holding one
      // back regardless would let a body containing `//` followed by a megabyte
      // of host-legal characters buffer without bound, which on a 128MB isolate
      // is a denial of service.
      if (match.length <= MAX_AUTHORITY) {
        return { rewritten: pieces.join('') + text.slice(cursor, m.index), rest: match };
      }
      pieces.push(text.slice(cursor, m.index), swapHost(match, isUpstreamHost, proxyHost));
      cursor = end;
      break;
    }
    pieces.push(text.slice(cursor, m.index), swapHost(match, isUpstreamHost, proxyHost));
    cursor = end;
  }
  pieces.push(text.slice(cursor));

  // A trailing partial scheme (`http`, `https:`, `https:/`) is not matched by the
  // pattern at all, yet the next chunk could complete it into a reference. Hold
  // back the longest such prefix so it is reconsidered rather than emitted.
  const emitted = pieces.join('');
  const dangling = danglingSchemeLength(emitted);
  return dangling === 0
    ? { rewritten: emitted, rest: '' }
    : { rewritten: emitted.slice(0, -dangling), rest: emitted.slice(-dangling) };
};

/**
 * Rewrites every reference in `text`, including one that touches its end.
 *
 * For the final chunk only, where nothing further can arrive and a reference at
 * the end is therefore complete rather than possibly truncated.
 */
const swapEveryHost = (
  text: string,
  isUpstreamHost: (host: string) => boolean,
  proxyHost: string,
): string =>
  text.replace(/(https?:)?\/\/[a-z0-9.-]+(:\d{1,5})?/gi, (match) =>
    swapHost(match, isUpstreamHost, proxyHost),
  );

/** Longest suffix that could be the start of `https://`, `http://`, or `//`. */
const danglingSchemeLength = (text: string): number => {
  for (const prefix of [
    'https:/',
    'https:',
    'https',
    'http:/',
    'http:',
    'http',
    'htt',
    'ht',
    'h',
    '/',
  ]) {
    if (text.endsWith(prefix)) {
      return prefix.length;
    }
  }
  return 0;
};

/** Replaces the authority of one absolute or protocol-relative reference. */
const swapHost = (
  match: string,
  isUpstreamHost: (host: string) => boolean,
  proxyHost: string,
): string => {
  let url: URL;
  try {
    url = new URL(match.startsWith('//') ? `https:${match}` : match);
  } catch {
    return match;
  }
  if (!isUpstreamHost(url.host)) {
    return match;
  }
  return match.startsWith('//') ? `//${proxyHost}` : `${url.protocol}//${proxyHost}`;
};

/**
 * A streaming rewriter for text bodies: URL-aware host rewriting first, then the
 * caller's literal replacements.
 *
 * The host pass runs on the same tail-buffered chunks so a URL straddling a chunk
 * boundary is still resolved. `keep` accounts for the longest thing either pass
 * could need to see whole.
 */
export const textRewriteStream = (
  replacements: readonly Replacement[],
  hostRewrite: { isUpstreamHost: (host: string) => boolean; proxyHost: string } | undefined,
  charset = 'utf-8',
): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder(charset);
  const encoder = new TextEncoder();
  const literalKeep =
    replacements.length === 0 ? 0 : Math.max(...replacements.map((r) => r.from.length)) - 1;
  // The host pass decides its own boundary, so only the literal needles set this.
  const keep = literalKeep;

  // The carry is bounded, and this is where that is decided, so it is asserted
  // here rather than left to be inferred. `literalKeep` is one short of the
  // longest needle because a needle that has arrived whole is replaced rather
  // than held: only a strict prefix of one can still be waiting. Raise it to the
  // full length and every chunk retains a byte it had already decided; drop it
  // and a needle straddling the boundary is split and silently missed. The host
  // pass adds its own bound (`MAX_AUTHORITY`) inside `rewriteTextUrls`, so the
  // total held is the sum of two constants and never grows with body size.
  const longestNeedle = replacements.reduce((n, r) => Math.max(n, r.from.length), 0);
  if (literalKeep !== Math.max(0, longestNeedle - 1)) {
    throw new Error(
      `carry bound broken: literalKeep=${literalKeep}, longest needle=${longestNeedle}`,
    );
  }

  /**
   * Rewrites `text`, returning what is decided and what must wait.
   *
   * `hold` is a lower bound on the tail to withhold, not a place to cut: slicing
   * there and emitting the front would commit text the passes had not finished
   * judging. So the tail is withheld first, and then each pass may withhold more
   * — `scan` reports how far it got, and the host pass hands back an authority
   * that ran to the end of what it saw. What is emitted is only what no pass
   * could still change.
   */
  const apply = (text: string, final: boolean): { emit: string; rest: string } => {
    if (hostRewrite === undefined) {
      return scan(text, replacements, final ? 0 : keep);
    }
    // No fixed slice point: `rewriteTextUrls` reports what it could not safely
    // judge, which is the only correct boundary. Cutting at a fixed offset
    // committed text mid-reference — a buffer ending in `https://` has no host to
    // compare yet, so emitting it left that URL unrewritten for good.
    //
    // On the final call nothing more can arrive, so a reference touching the end
    // is complete: it must be judged, not held back and not passed through.
    const hosted = final
      ? swapEveryHost(text, hostRewrite.isUpstreamHost, hostRewrite.proxyHost)
      : rewriteTextUrls(text, hostRewrite.isUpstreamHost, hostRewrite.proxyHost).rewritten;
    const undecided = final
      ? ''
      : rewriteTextUrls(text, hostRewrite.isUpstreamHost, hostRewrite.proxyHost).rest;

    if (replacements.length === 0) {
      return { emit: hosted, rest: undecided };
    }
    // The literal pass then applies its own hold-back over what the host pass
    // released, so a needle straddling that point is not split.
    const literal = scan(hosted, replacements, final ? 0 : literalKeep);
    return {
      emit: literal.emit + (final ? literal.rest : ''),
      rest: final ? '' : literal.rest + undecided,
    };
  };

  let carry = '';
  return new TransformStream({
    transform(chunk, controller) {
      // `stream: true` keeps multi-byte characters intact across chunks.
      const { emit, rest } = apply(carry + decoder.decode(chunk, { stream: true }), false);
      carry = rest;
      if (emit !== '') {
        controller.enqueue(encoder.encode(emit));
      }
    },
    flush(controller) {
      // Nothing follows, so the whole remainder is decided.
      const { emit, rest } = apply(carry + decoder.decode(), true);
      const tail = emit + rest;
      if (tail !== '') {
        controller.enqueue(encoder.encode(tail));
      }
    },
  });
};

/**
 * Replaces literal strings across a stream, decoding `charset` and emitting
 * UTF-8. A thin wrapper over `textRewriteStream` for callers that need only the
 * literal pass; see there for the chunk-boundary handling.
 */
export const textReplaceStream = (
  replacements: readonly Replacement[],
  charset = 'utf-8',
): TransformStream<Uint8Array, Uint8Array> => textRewriteStream(replacements, undefined, charset);

/** Parsed `content-type`: the bare media type plus its charset, if declared. */
export interface ContentType {
  type: string;
  charset: string | undefined;
}

export const parseContentType = (value: string | null): ContentType | undefined => {
  if (value === null) {
    return undefined;
  }
  const type = value.split(';')[0]!.trim().toLowerCase();
  if (type === '') {
    return undefined;
  }
  const charset = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(value)?.[1]?.trim().toLowerCase();
  return { type, charset };
};

/** True when the content type is one we are willing to rewrite. */
export const shouldRewrite = (contentType: string | null, allowed: readonly string[]): boolean => {
  const parsed = parseContentType(contentType);
  if (parsed === undefined) {
    return false;
  }
  return allowed.some((a) => parsed.type.startsWith(a.toLowerCase()));
};

/**
 * Labels that this runtime decodes as UTF-8, so the bytes pass through unchanged.
 *
 * Only true UTF-8 aliases belong here. `us-ascii` and `ascii` look safe — every
 * byte below 0x80 is identical in both — but workerd maps them to a
 * windows-1252 decoder, so a high byte decodes to a character that re-encodes as
 * two UTF-8 bytes. Verified: `0x41 0xE9 0x42` labelled `us-ascii` came back as
 * `A é B` in four bytes. Treating them as pass-through changed the body while
 * leaving `Content-Type` claiming the original charset.
 */
const UTF8_LABELS = new Set([
  'utf-8',
  'utf8',
  'unicode-1-1-utf-8',
  'unicode11utf8',
  'unicode20utf8',
  'x-unicode20utf8',
]);

/**
 * Decides how to decode a body, or declines to touch it.
 *
 * Returns the charset to decode with and whether the response's `content-type`
 * must then be corrected to UTF-8, or `undefined` when the encoding is unknown to
 * this runtime — in which case passing the bytes through untouched is the only
 * safe answer, since decoding them wrongly would corrupt every character.
 */
export const resolveCharset = (
  declared: string | undefined,
  fallback: string | undefined,
): { charset: string; transcoded: boolean } | undefined => {
  const candidate = declared ?? fallback;
  if (candidate === undefined) {
    // Nothing declared: UTF-8 is the only defensible assumption for text, and it
    // is what the previous behaviour did for every body.
    return { charset: 'utf-8', transcoded: false };
  }
  if (UTF8_LABELS.has(candidate)) {
    return { charset: candidate, transcoded: false };
  }
  if (!isSupportedCharset(candidate)) {
    return undefined;
  }
  // Anything else this runtime can decode is re-encoded as UTF-8 on the way out,
  // so the declared charset has to be corrected.
  return { charset: candidate, transcoded: true };
};

/**
 * Whether a charset label can be decoded, which is not the runtime-capability
 * question it looks like.
 *
 * workerd compiles the full WHATWG encoding set — verified: gbk, gb18030, big5,
 * shift_jis, euc-jp, euc-kr, koi8-r, iso-2022-jp, macintosh and the windows-*
 * family all decode, and GBK bytes come back as the right characters. (The
 * Cloudflare encoding docs describe only "a UTF-8 decoder"; they are wrong.) So
 * this never fails for lack of an ICU table.
 *
 * What it does catch is a label the spec maps to `Replacement` — `iso-2022-kr`,
 * `hz-gb-2312` and their aliases — which `TextDecoder` refuses with a
 * `RangeError`. That mapping exists to stop those encodings being used to smuggle
 * ASCII past a filter, so refusing to serve such a body is the right answer, and
 * an unrecognised label is refused by the same path. Constructing the decoder is
 * the only way to ask; the instance itself is discarded.
 */
const isSupportedCharset = (charset: string): boolean => {
  try {
    const probe = new TextDecoder(charset);
    return probe.encoding !== '';
  } catch {
    return false;
  }
};

/**
 * Rewrites a URL-bearing value so hosts belonging to the upstream point at the
 * proxy instead.
 *
 * Each candidate is parsed as a URL and its host compared exactly, rather than
 * substituting the host as a substring. Substring replacement rewrote
 * `https://o.test.evil.com/b` into `https://p.dev.evil.com/b` — verified — which
 * both breaks the link and hands an attacker a way to make the proxy's own
 * hostname appear inside a domain they control.
 *
 * Non-HTTP schemes (`data:`, `mailto:`, `javascript:`) and relative values are
 * returned untouched: relative values already stay on the proxy.
 */
export const rewriteUrlValue = (
  value: string,
  isUpstreamHost: (host: string) => boolean,
  proxyHost: string,
  base: string,
): string => {
  // srcset and ping hold several URLs; splitting on whitespace and commas
  // handles both, and rejoining with the original separators keeps descriptors
  // like `2x` in place.
  return value.replace(/[^\s,]+/g, (token) =>
    rewriteOneUrl(token, isUpstreamHost, proxyHost, base),
  );
};

const rewriteOneUrl = (
  token: string,
  isUpstreamHost: (host: string) => boolean,
  proxyHost: string,
  base: string,
): string => {
  // A descriptor like `2x` or `640w` is not a URL.
  if (/^\d+(\.\d+)?[xw]$/.test(token)) {
    return token;
  }
  let url: URL;
  try {
    url = new URL(token, base);
  } catch {
    return token;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return token;
  }
  if (!isUpstreamHost(url.host)) {
    return token;
  }
  // Only absolute references name a host, so only they need rewriting.
  if (!/^(https?:)?\/\//i.test(token)) {
    return token;
  }
  url.host = proxyHost;
  // Preserve a protocol-relative reference rather than pinning a scheme.
  return token.startsWith('//')
    ? `//${url.host}${url.pathname}${url.search}${url.hash}`
    : url.toString();
};

/** Rewrites `url(...)` references inside CSS text. */
export const rewriteCss = (
  css: string,
  isUpstreamHost: (host: string) => boolean,
  proxyHost: string,
  base: string,
): string =>
  css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote: string, target: string) => {
    const rewritten = rewriteOneUrl(target.trim(), isUpstreamHost, proxyHost, base);
    return rewritten === target.trim() ? whole : `url(${quote}${rewritten}${quote})`;
  });

/** Rewrites the `url=` part of a `<meta http-equiv="refresh">` content value. */
export const rewriteMetaRefresh = (
  content: string,
  isUpstreamHost: (host: string) => boolean,
  proxyHost: string,
  base: string,
): string =>
  content.replace(
    /(url\s*=\s*)(['"]?)([^'";]+)\2/i,
    (whole, prefix: string, quote: string, target: string) => {
      const rewritten = rewriteOneUrl(target.trim(), isUpstreamHost, proxyHost, base);
      return rewritten === target.trim() ? whole : `${prefix}${quote}${rewritten}${quote}`;
    },
  );

/**
 * Cap on the text of one `<style>` node held in memory while waiting to rewrite
 * it as a whole.
 *
 * A `url(...)` can straddle two chunks, so the node has to be accumulated before
 * it can be rewritten — but accumulating without a bound is exactly the
 * whole-body buffering this file opens by ruling out. Verified in workerd: a
 * single 4.2MB `<style>` node was held complete in a JS string, and nothing
 * stopped it being 60MB inside a 128MB isolate.
 *
 * 256KB is far above real inline stylesheets (typically well under 50KB) and far
 * below the isolate limit. Past it the node is emitted unrewritten: losing a
 * background image on a pathological page is a visible, debuggable miss, whereas
 * running the isolate out of memory takes down every request it was serving.
 */
const MAX_STYLE_BUFFER = 256 * 1024;

export interface HtmlRewriteOptions {
  /** Hosts belonging to the upstream, including sibling subdomains. */
  isUpstreamHost: (host: string) => boolean;
  /** Host to point rewritten URLs at. */
  proxyHost: string;
  /** Base for resolving relative references; the upstream request URL. */
  base: string;
  /** Also rewrite `<style>` text, inline `style` attributes and meta refresh. */
  rewriteStyles: boolean;
}

/**
 * Rewrites URL-bearing markup so hosts belonging to the upstream point at the
 * proxy. Text nodes outside `<style>` are left alone: rewriting prose or inline
 * script bodies risks corrupting them for no navigational benefit.
 */
export const htmlRewriter = ({
  isUpstreamHost,
  proxyHost,
  base,
  rewriteStyles,
}: HtmlRewriteOptions): HTMLRewriter => {
  const rewrite = (value: string): string =>
    rewriteUrlValue(value, isUpstreamHost, proxyHost, base);
  // Accumulates one `<style>` text node across however many chunks it arrives in.
  let styleBuffer = '';
  // Set once a node has outgrown MAX_STYLE_BUFFER, so its remaining chunks pass
  // straight through instead of being accumulated.
  let styleOverflowed = false;

  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      for (const attribute of URL_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value === null) {
          continue;
        }
        const rewritten = rewrite(value);
        if (rewritten !== value) {
          element.setAttribute(attribute, rewritten);
        }
      }
      if (!rewriteStyles) {
        return;
      }
      const style = element.getAttribute('style');
      if (style !== null) {
        const rewritten = rewriteCss(style, isUpstreamHost, proxyHost, base);
        if (rewritten !== style) {
          element.setAttribute('style', rewritten);
        }
      }
      // `srcdoc` holds a whole nested document, so the attribute-level pass does
      // not apply: its value is markup, not a URL. Rewriting its absolute hosts
      // as text covers the navigable references without a second parser — the
      // URL-comparison pass, so a lookalike host inside it is still safe.
      const srcdoc = element.getAttribute('srcdoc');
      if (srcdoc !== null) {
        const { rewritten } = rewriteTextUrls(srcdoc, isUpstreamHost, proxyHost);
        if (rewritten !== srcdoc) {
          element.setAttribute('srcdoc', rewritten);
        }
      }
    },
  });

  if (!rewriteStyles) {
    return rewriter;
  }

  return rewriter
    .on('meta[http-equiv]', {
      element(element) {
        if (element.getAttribute('http-equiv')?.toLowerCase() !== 'refresh') {
          return;
        }
        const content = element.getAttribute('content');
        if (content === null) {
          return;
        }
        const rewritten = rewriteMetaRefresh(content, isUpstreamHost, proxyHost, base);
        if (rewritten !== content) {
          element.setAttribute('content', rewritten);
        }
      },
    })
    .on('style', {
      // A text node can arrive in several chunks when the document itself is
      // streamed, and a `url(...)` may span two of them. Accumulate until
      // `lastInTextNode`, then rewrite once and emit — the alternative rewrote
      // each fragment separately and missed anything that straddled a boundary.
      //
      // Accumulation is capped: see MAX_STYLE_BUFFER. Past the cap the node is
      // emitted unrewritten rather than held, because holding it is the one
      // failure this file exists to avoid.
      text(chunk) {
        if (styleOverflowed) {
          // Already given up on this node; let its remaining text through as is.
          if (chunk.lastInTextNode) {
            styleOverflowed = false;
          }
          return;
        }

        styleBuffer += chunk.text;

        if (styleBuffer.length > MAX_STYLE_BUFFER) {
          // Emit what was withheld, unrewritten, and stop buffering this node.
          // Rewriting here would allocate a second copy of an already oversized
          // string, which is the opposite of what the cap is for.
          const held = styleBuffer;
          styleBuffer = '';
          styleOverflowed = !chunk.lastInTextNode;
          chunk.replace(held, { html: true });
          return;
        }

        if (!chunk.lastInTextNode) {
          // Remove the fragment; the whole node is re-emitted on the last chunk.
          chunk.remove();
          return;
        }
        const rewritten = rewriteCss(styleBuffer, isUpstreamHost, proxyHost, base);
        styleBuffer = '';
        chunk.replace(rewritten, { html: true });
      },
    });
};

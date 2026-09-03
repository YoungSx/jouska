import { describe, expect, it } from 'vitest';
import {
  contentTypeAllowed,
  htmlRewriter,
  parseContentType,
  resolveCharset,
  scan,
  textReplaceStream,
  textRewriteStream,
  type InjectConfig,
  type InjectReport,
} from '../../src/internal/body';
import { upstreamHostMatcher } from '../../src/internal/headers';

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
};

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

const run = (chunks: readonly string[], replacements: { from: string; to: string }[]) =>
  collect(streamOf(chunks).pipeThrough(textReplaceStream(replacements)));

describe('textReplaceStream', () => {
  it('replaces within a single chunk', async () => {
    expect(await run(['a origin.test b'], [{ from: 'origin.test', to: 'p.dev' }])).toBe(
      'a p.dev b',
    );
  });

  it('replaces a match split across chunks', async () => {
    // 'origin.test' is cut in half — the naive per-chunk approach misses this.
    expect(await run(['x ori', 'gin.test y'], [{ from: 'origin.test', to: 'p.dev' }])).toBe(
      'x p.dev y',
    );
  });

  it('replaces a match split one byte at a time', async () => {
    const chunks = 'see origin.test now'.split('');
    expect(await run(chunks, [{ from: 'origin.test', to: 'p.dev' }])).toBe('see p.dev now');
  });

  it('replaces every occurrence', async () => {
    expect(await run(['a.test a.test a.test'], [{ from: 'a.test', to: 'b' }])).toBe('b b b');
  });

  it('preserves multi-byte characters split across chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('前缀 origin.test 后缀');
    // Split mid-character to prove the decoder is streaming.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    const out = await collect(
      stream.pipeThrough(textReplaceStream([{ from: 'origin.test', to: 'p.dev' }])),
    );
    expect(out).toBe('前缀 p.dev 后缀');
  });

  it('passes content through unchanged when nothing matches', async () => {
    expect(await run(['nothing here'], [{ from: 'zzz', to: 'y' }])).toBe('nothing here');
  });

  it('handles an empty body', async () => {
    expect(await run([], [{ from: 'a', to: 'b' }])).toBe('');
  });

  it('does not cascade: replaced output is not re-scanned', async () => {
    // A single pass means rules cannot chain into each other, which keeps a
    // config like {a->b, b->c} from silently turning every `a` into `c`.
    expect(
      await run(
        ['one'],
        [
          { from: 'one', to: 'two' },
          { from: 'two', to: 'three' },
        ],
      ),
    ).toBe('two');
  });

  it('prefers the earlier rule when two match at the same position', async () => {
    expect(
      await run(
        ['abc'],
        [
          { from: 'ab', to: 'X' },
          { from: 'abc', to: 'Y' },
        ],
      ),
    ).toBe('Xc');
  });
});

describe('contentTypeAllowed', () => {
  const allowed = (header: string | null, list: readonly string[]): boolean =>
    contentTypeAllowed(parseContentType(header), list);

  it('matches ignoring charset parameters', () => {
    expect(allowed('text/html; charset=utf-8', ['text/html'])).toBe(true);
  });
  it('rejects unlisted types', () => {
    expect(allowed('image/png', ['text/html'])).toBe(false);
  });
  it('rejects a missing content type', () => {
    expect(allowed(null, ['text/html'])).toBe(false);
  });
});

describe('resolveCharset', () => {
  it('uses the fallback when the declared label cannot be decoded', () => {
    // The case the option is named and documented for. It used to return
    // undefined here, because `declared ?? fallback` short-circuits on any
    // declared value however unusable — so the option did nothing in exactly the
    // situation its docstring described. `iso-2022-kr` is mapped to Replacement
    // by the encoding spec, so TextDecoder refuses it outright.
    expect(resolveCharset('x-nonsense', 'gbk')).toEqual({ charset: 'gbk', transcoded: true });
    expect(resolveCharset('iso-2022-kr', 'gbk')).toEqual({ charset: 'gbk', transcoded: true });
  });

  it('prefers a usable declared label over the fallback', () => {
    expect(resolveCharset('big5', 'gbk')).toEqual({ charset: 'big5', transcoded: true });
  });

  it('uses the fallback when nothing is declared', () => {
    expect(resolveCharset(undefined, 'gbk')).toEqual({ charset: 'gbk', transcoded: true });
  });

  it('assumes UTF-8 when neither is given', () => {
    expect(resolveCharset(undefined, undefined)).toEqual({ charset: 'utf-8', transcoded: false });
  });

  it('does not transcode a body already labelled UTF-8', () => {
    expect(resolveCharset('utf-8', undefined)).toEqual({ charset: 'utf-8', transcoded: false });
  });

  it('declines when neither the declared label nor the fallback is usable', () => {
    // Passing the bytes through untouched is the only safe answer; assuming
    // UTF-8 would corrupt every character while the header kept the old label.
    expect(resolveCharset('x-nonsense', 'also-nonsense')).toBeUndefined();
    expect(resolveCharset('x-nonsense', undefined)).toBeUndefined();
  });

  it('declines when nothing is declared and the fallback is unusable', () => {
    // Not a silent downgrade to UTF-8: the operator asked for a specific
    // charset, and quietly substituting another would corrupt the body.
    expect(resolveCharset(undefined, 'x-nonsense')).toBeUndefined();
  });
});

describe('htmlRewriter', () => {
  const rewrite = async (html: string): Promise<string> => {
    const { rewriter } = htmlRewriter({
      isUpstreamHost: upstreamHostMatcher('origin.test'),
      proxyHost: 'p.dev',
      base: 'https://origin.test/',
      rewriteStyles: true,
      rewriteLinks: true,
    });
    const res = rewriter.transform(
      new Response(html, { headers: { 'content-type': 'text/html' } }),
    );
    return res.text();
  };

  it('rewrites href and src hosts', async () => {
    const out = await rewrite(
      '<a href="https://origin.test/x">l</a><img src="https://origin.test/i.png">',
    );
    expect(out).toContain('https://p.dev/x');
    expect(out).toContain('https://p.dev/i.png');
    expect(out).not.toContain('origin.test');
  });

  it('leaves third-party and relative URLs alone', async () => {
    const out = await rewrite('<a href="https://other.test/x">o</a><a href="/rel">r</a>');
    expect(out).toContain('https://other.test/x');
    expect(out).toContain('/rel');
  });

  it('does not rewrite text content', async () => {
    const out = await rewrite('<p>visit origin.test today</p>');
    expect(out).toContain('visit origin.test today');
  });

  it('survives emoji in the document', async () => {
    // The WASM shim we avoided had an open emoji crash; the native one must not.
    const out = await rewrite('<p>🎉🚀</p><a href="https://origin.test/e">e</a>');
    expect(out).toContain('🎉🚀');
    expect(out).toContain('https://p.dev/e');
  });
});

describe('htmlRewriter inject', () => {
  /**
   * Runs the rewriter with an inject config and returns the output text plus the
   * anchor verdict, which settles only once the document has drained.
   */
  const inject = async (
    html: string,
    config: InjectConfig,
    links = true,
  ): Promise<{ out: string; report?: InjectReport }> => {
    const { rewriter, inject: stage } = htmlRewriter({
      isUpstreamHost: upstreamHostMatcher('origin.test'),
      proxyHost: 'p.dev',
      base: 'https://origin.test/',
      rewriteStyles: true,
      rewriteLinks: links,
      inject: config,
    });
    const res = rewriter.transform(
      new Response(html, { headers: { 'content-type': 'text/html' } }),
    );
    const out =
      stage === undefined
        ? await res.text()
        : await new Response(res.body!.pipeThrough(stage.stream)).text();
    return stage === undefined ? { out } : { out, report: await stage.report };
  };

  it('lands all four anchors on a well-formed document', async () => {
    const { out, report } = await inject(
      '<html><head><title>t</title></head><body><p>hi</p></body></html>',
      { headStart: '<A>', headEnd: '<B>', bodyStart: '<C>', bodyEnd: '<D>' },
    );
    expect(out).toBe(
      '<html><head><A><title>t</title><B></head><body><C><p>hi</p><D></body></html>',
    );
    expect(report).toEqual({
      landed: ['headStart', 'headEnd', 'bodyStart', 'bodyEnd'],
      missed: [],
    });
  });

  it('matches uppercase tags, which the parser treats like any other spelling', async () => {
    const { out, report } = await inject('<HTML><HEAD></HEAD><BODY><P>hi</P></BODY></HTML>', {
      headStart: '<A>',
      bodyEnd: '<D>',
    });
    expect(out).toContain('<A>');
    expect(out).toContain('<D>');
    expect(report).toEqual({ landed: ['headStart', 'bodyEnd'], missed: [] });
  });

  it('lands the start-tag anchors even when the document never closes the element', async () => {
    // Measured in workerd: `prepend` fires on the start tag, `onEndTag` needs the
    // closing tag to exist. A page truncated by an origin keeps its banner and
    // loses its footer — and the verdict is what makes that visible.
    const { out, report } = await inject('<html><head><title>open', {
      headStart: '<A>',
      headEnd: '<B>',
    });
    expect(out).toContain('<A>');
    expect(out).not.toContain('<B>');
    expect(report).toEqual({ landed: ['headStart'], missed: ['headEnd'] });
  });

  it('reports every anchor as missed for a document that has neither head nor body', async () => {
    // Measured in workerd: the parser never *creates* implied elements, so no
    // head or body handler fires at all. The miss is a real outcome, not an
    // error — the rewriter must not throw on a fragment.
    const { out, report } = await inject('<p>fragment</p>', {
      headStart: '<A>',
      headEnd: '<B>',
      bodyStart: '<C>',
      bodyEnd: '<D>',
    });
    expect(out).toBe('<p>fragment</p>');
    expect(report).toEqual({
      landed: [],
      missed: ['headStart', 'headEnd', 'bodyStart', 'bodyEnd'],
    });
  });

  it('injects once per document even when an anchor is configured on both ends', async () => {
    const { out } = await inject('<html><head></head><body></body></html>', {
      headStart: '<A>',
    });
    expect(out).toBe('<html><head><A></head><body></body></html>');
  });

  it('leaves the injected markup out of the URL-attribute pass', async () => {
    // Pinned after measuring in workerd: an element inserted by a handler is
    // never visited by the same rewriter's other handlers, so the `.on('*')`
    // pass cannot rewrite what the anchors put in. That is the contract, not a
    // side effect — if a runtime ever starts re-visiting injected elements, this
    // assertion is the one that catches it.
    const { out, report } = await inject(
      '<html><head></head><body><a href="https://origin.test/x">l</a></body></html>',
      { headEnd: '<script src="https://origin.test/injected.js"></script>' },
    );
    // The document's own link is rewritten; the injected reference is not.
    expect(out).toContain('href="https://p.dev/x"');
    expect(out).toContain('<script src="https://origin.test/injected.js"></script>');
    expect(report).toEqual({ landed: ['headEnd'], missed: [] });
  });

  it('injects into a document it is not otherwise rewriting', async () => {
    // `rewriteLinks: false` reaches the HTML path for the injection alone, and
    // the URL-attribute pass stays off with it.
    const { out, report } = await inject(
      '<html><head></head><body><a href="https://origin.test/x">l</a></body></html>',
      { bodyStart: '<div class="mirror-banner">mirror</div>' },
      false,
    );
    expect(out).toContain('href="https://origin.test/x"');
    expect(out).toContain('<div class="mirror-banner">mirror</div>');
    expect(report).toEqual({ landed: ['bodyStart'], missed: [] });
  });

  it('settles the verdict even when the client cancels the body', async () => {
    const { rewriter, inject: stage } = htmlRewriter({
      isUpstreamHost: upstreamHostMatcher('origin.test'),
      proxyHost: 'p.dev',
      base: 'https://origin.test/',
      rewriteStyles: true,
      rewriteLinks: true,
      inject: { bodyStart: '<A>' },
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html><head></head><body><p>hi'));
        // No close: the reader decides when this ends, as a hang-up does.
      },
      cancel() {
        // Nothing to release; the source is memory.
      },
    });
    const res = rewriter.transform(
      new Response(source, { headers: { 'content-type': 'text/html' } }),
    );
    const reader = res.body!.pipeThrough(stage!.stream).getReader();
    await reader.read();
    await reader.cancel();
    // A hang-up mid-document is exactly when "did it land" is worth asking, so
    // the promise must settle there rather than hang forever. How far the
    // rewriter got before the cancel is a scheduling detail, so the stable claim
    // is the partition: every configured anchor is reported exactly once, as
    // landed if the rewriter had reached it, missed otherwise.
    const report = await stage!.report;
    expect([...report.landed, ...report.missed]).toEqual(['bodyStart']);
    expect(report.landed.some((a) => report.missed.includes(a))).toBe(false);
  });
});

describe('textReplaceStream regressions', () => {
  const through = async (
    input: string,
    replacements: readonly { from: string; to: string }[],
    charset?: string,
  ): Promise<string> => {
    const body = new Response(input).body!;
    const out = body.pipeThrough(
      charset === undefined
        ? textReplaceStream(replacements)
        : textReplaceStream(replacements, charset),
    );
    return new Response(out).text();
  };

  it('passes a body through unchanged when the table is empty', async () => {
    // `Math.max(0, ...[])` yielded 0, so `keep` became -1: a negative hold-back
    // sliced off the final character, which flush then appended to the literal
    // string "undefined". Verified: "hello world" came back as
    // "hello worldundefined".
    expect(await through('hello world', [])).toBe('hello world');
  });

  it('emits the tail even when it cannot be scanned', async () => {
    // The held-back remainder has to be flushed, not dropped.
    expect(await through('abcabX', [{ from: 'abc', to: 'Z' }])).toBe('ZabX');
  });

  it('applies rules in a single pass so they never cascade', async () => {
    expect(
      await through('ab', [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ]),
    ).toBe('bc');
  });

  it('prefers the earliest match, then the earlier rule', async () => {
    expect(
      await through('xaby', [
        { from: 'ab', to: '1' },
        { from: 'a', to: '2' },
      ]),
    ).toBe('x1y');
  });

  it('decodes the charset it is given', async () => {
    const bytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    const out = await new Response(
      new Response(bytes).body!.pipeThrough(textReplaceStream([], 'gb2312')),
    ).text();
    expect(out).toBe('你好');
  });

  it('scans by jumping between candidates rather than character by character', async () => {
    // The original scan tested every character, costing 30ms of CPU on this
    // input against a 10ms per-request limit on the free plan. Asserting a
    // wall-clock budget would be flaky on a cold isolate, so this compares
    // against the shape it replaced — measured here, so the comparison holds on
    // whatever machine runs it. `scan` is exercised directly: the surrounding
    // stream's chunk scheduling costs more than either algorithm and would
    // drown out the difference.
    const css = 'body{background:url(https://o.test/bg.png)}'.repeat(12_000);

    const characterwiseStart = Date.now();
    let naive = '';
    for (let i = 0; i < css.length;) {
      if (css.startsWith('o.test', i)) {
        naive += 'p.dev';
        i += 'o.test'.length;
      } else {
        naive += css[i];
        i += 1;
      }
    }
    const characterwise = Date.now() - characterwiseStart;

    const startedAt = Date.now();
    const { emit } = scan(css, [{ from: 'o.test', to: 'p.dev' }], 0);
    const jumping = Date.now() - startedAt;

    // Byte-identical output, several times cheaper. Measured at 25ms against
    // 3ms; the assertion only demands it not be slower, so it cannot go stale.
    expect(emit).toBe(naive);
    expect(jumping).toBeLessThanOrEqual(characterwise);
  });

  it('still rewrites the whole body when streamed', async () => {
    const css = 'body{background:url(https://o.test/bg.png)}'.repeat(12_000);
    const out = await through(css, [{ from: 'o.test', to: 'p.dev' }]);
    expect(out).not.toContain('o.test');
    expect(out.split('p.dev')).toHaveLength(12_001);
  });
});

describe('textRewriteStream guards', () => {
  it('refuses an empty needle, naming the actual problem', () => {
    // `indexOf('')` is 0 and consuming it advances nothing, so `scan` would spin
    // forever — a hung isolate rather than a wrong answer. The schema already
    // requires a non-empty `from`, so this covers direct internal callers.
    //
    // The previous assert caught the same case (it was the only way to break the
    // carry bound) but reported `carry bound broken: literalKeep=-1`, which named
    // neither the cause nor the fix.
    expect(() => textRewriteStream([{ from: '', to: 'x' }], undefined)).toThrow(
      /`from` must not be empty/,
    );
  });

  it('accepts a single-character needle', () => {
    // The boundary case: `literalKeep` is 0 here, the same value the empty needle
    // would want, so the guard has to distinguish them rather than reject both.
    expect(() => textRewriteStream([{ from: 'a', to: 'x' }], undefined)).not.toThrow();
  });
});

describe('textRewriteStream hold-back boundaries', () => {
  const upstream = upstreamHostMatcher('o.test');
  const pipe = (
    chunks: readonly string[],
    replacements: { from: string; to: string }[],
    hostRewrite: boolean,
  ) =>
    collect(
      streamOf(chunks).pipeThrough(
        textRewriteStream(
          replacements,
          hostRewrite ? { isUpstreamHost: upstream, proxyHost: 'p.dev' } : undefined,
        ),
      ),
    );

  /** The internal hold-back the host pass needs to see an authority whole. */
  const HOST_KEEP = 274;

  it('replaces a needle straddling the boundary with host rewriting on', async () => {
    // Doing the host pass first and then handing the literal pass a zero
    // hold-back split the needle across the boundary, so neither half matched —
    // reintroducing the exact defect the hold-back exists to prevent.
    const needle = 'origin.test';
    const text = `ab${needle}${'Z'.repeat(HOST_KEEP + 5 - 2 - needle.length)}`;
    expect(await pipe([text], [{ from: needle, to: 'PROXY' }], true)).toContain('PROXY');
  });

  it('does not rewrite a host truncated at the boundary', async () => {
    // A buffer ending part-way through `o.test.evil.com` looks exactly like
    // `o.test`. Judging it there would recreate the lookalike hole that parsing
    // each candidate exists to close.
    const url = 'https://o.test.evil.com/b';
    const head = `.a{background:url(${url})}`;
    const out = await pipe([head + 'x'.repeat(HOST_KEEP + 10)], [], true);
    expect(out).toContain(url);
    expect(out).not.toContain('p.dev');
  });

  it('rewrites an authority that arrives in two chunks', async () => {
    expect(await pipe(['url(https://o.te', 'st/b.png)'], [], true)).toBe(
      'url(https://p.dev/b.png)',
    );
  });

  it('does not buffer without bound on a long host-legal run', async () => {
    // `//` followed by a megabyte of host-legal characters would otherwise be
    // held back in full, waiting for an authority that can never be valid — on a
    // 128MB isolate that is a denial of service. A hostname is at most 253
    // characters, so anything past that is judged immediately.
    const long = `x //${'a'.repeat(100_000)}`;
    const out = await pipe([long], [], true);
    expect(out).toHaveLength(long.length);
  });

  it('still holds back a plausible authority at the very end', async () => {
    expect(await pipe(['x //o.te', 'st/a'], [], true)).toBe('x //p.dev/a');
  });
});

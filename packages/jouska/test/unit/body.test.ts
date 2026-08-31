import { describe, expect, it } from 'vitest';
import {
  htmlRewriter,
  resolveCharset,
  scan,
  shouldRewrite,
  textReplaceStream,
  textRewriteStream,
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

describe('shouldRewrite', () => {
  it('matches ignoring charset parameters', () => {
    expect(shouldRewrite('text/html; charset=utf-8', ['text/html'])).toBe(true);
  });
  it('rejects unlisted types', () => {
    expect(shouldRewrite('image/png', ['text/html'])).toBe(false);
  });
  it('rejects a missing content type', () => {
    expect(shouldRewrite(null, ['text/html'])).toBe(false);
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
    const res = htmlRewriter({
      isUpstreamHost: upstreamHostMatcher('origin.test'),
      proxyHost: 'p.dev',
      base: 'https://origin.test/',
      rewriteStyles: true,
    }).transform(new Response(html, { headers: { 'content-type': 'text/html' } }));
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

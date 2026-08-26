import { describe, expect, it } from 'vitest';
import { htmlRewriter, shouldRewrite, textReplaceStream } from '../../src/internal/body';

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
    expect(await run(['a origin.test b'], [{ from: 'origin.test', to: 'p.dev' }]))
      .toBe('a p.dev b');
  });

  it('replaces a match split across chunks', async () => {
    // 'origin.test' is cut in half — the naive per-chunk approach misses this.
    expect(await run(['x ori', 'gin.test y'], [{ from: 'origin.test', to: 'p.dev' }]))
      .toBe('x p.dev y');
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
    const out = await collect(stream.pipeThrough(textReplaceStream([{ from: 'origin.test', to: 'p.dev' }])));
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
    expect(await run(['one'], [{ from: 'one', to: 'two' }, { from: 'two', to: 'three' }]))
      .toBe('two');
  });

  it('prefers the earlier rule when two match at the same position', async () => {
    expect(await run(['abc'], [{ from: 'ab', to: 'X' }, { from: 'abc', to: 'Y' }]))
      .toBe('Xc');
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

describe('htmlRewriter', () => {
  const rewrite = async (html: string): Promise<string> => {
    const res = htmlRewriter('origin.test', 'p.dev').transform(
      new Response(html, { headers: { 'content-type': 'text/html' } }),
    );
    return res.text();
  };

  it('rewrites href and src hosts', async () => {
    const out = await rewrite('<a href="https://origin.test/x">l</a><img src="https://origin.test/i.png">');
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

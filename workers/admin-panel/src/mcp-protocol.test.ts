/**
 * Unit tests for the pure wire helpers.
 *
 * These three are where a subtle mistake is invisible end-to-end: a decoder that
 * mishandles the sentinel rejects conforming requests, a media-type check that
 * splits wrongly rejects every charset-bearing client, and a body cap that is
 * off by one byte is a cap nobody notices until it is a bill.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeMcpHeaderValue,
  isJsonMediaType,
  MCP_BODY_MAX_BYTES,
  readBoundedBody,
} from './mcp-protocol.js';

const streamed = (bytes: Uint8Array): Request =>
  new Request('https://panel.test/mcp', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks: a limit that only reads the first would pass a body twice
        // its size.
        controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
        controller.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
        controller.close();
      },
    }),
    // @ts-expect-error streaming upload is a workerd extension to RequestInit
    duplex: 'half',
  });

describe('decodeMcpHeaderValue', () => {
  it('passes a plain value through untouched', () => {
    expect(decodeMcpHeaderValue('get_config')).toBe('get_config');
  });

  it('decodes the sentinel form as UTF-8', () => {
    expect(decodeMcpHeaderValue('=?base64?Z2V0X2NvbmZpZw==?=')).toBe('get_config');
    expect(decodeMcpHeaderValue('=?base64?5rWL6K+V?=')).toBe('测试');
  });

  it('reports no usable value for an absent or malformed header', () => {
    // Both end in the same rejection, but neither may be mistaken for a name:
    // returning the raw text would compare garbage against the body.
    expect(decodeMcpHeaderValue(null)).toBeUndefined();
    expect(decodeMcpHeaderValue('=?base64?not base64!?=')).toBeUndefined();
    expect(decodeMcpHeaderValue('=?base64?/w==?=')).toBeUndefined();
  });

  it('rejects a value whose markers overlap', () => {
    expect(decodeMcpHeaderValue('=?base64?=')).toBeUndefined();
  });

  it('decodes an empty payload to an empty string', () => {
    expect(decodeMcpHeaderValue('=?base64??=')).toBe('');
  });

  it('leaves a value that only resembles the sentinel alone', () => {
    expect(decodeMcpHeaderValue('=?base32?abc?=')).toBe('=?base32?abc?=');
    expect(decodeMcpHeaderValue('prefix=?base64?abc?=')).toBe('prefix=?base64?abc?=');
  });
});

describe('isJsonMediaType', () => {
  it('accepts application/json with parameters and any casing', () => {
    expect(isJsonMediaType('application/json')).toBe(true);
    expect(isJsonMediaType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonMediaType('Application/JSON')).toBe(true);
    expect(isJsonMediaType(' application/json ')).toBe(true);
  });

  it('rejects everything else, including an absent header', () => {
    expect(isJsonMediaType(null)).toBe(false);
    expect(isJsonMediaType('')).toBe(false);
    expect(isJsonMediaType('text/plain')).toBe(false);
    expect(isJsonMediaType('application/json-patch+json')).toBe(false);
  });
});

describe('readBoundedBody', () => {
  it('reads a body that fits, across chunk boundaries', async () => {
    const read = await readBoundedBody(streamed(new TextEncoder().encode('{"a":1}')), 1024);
    expect(read).toEqual({ ok: true, text: '{"a":1}' });
  });

  it('accepts exactly the cap and refuses one byte more', async () => {
    const atCap = await readBoundedBody(streamed(new Uint8Array(64).fill(0x61)), 64);
    expect(atCap.ok).toBe(true);
    const overCap = await readBoundedBody(streamed(new Uint8Array(65).fill(0x61)), 64);
    expect(overCap).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses an oversize body that declares no length at all', async () => {
    // The case content-length cannot catch: a chunked upload makes no claim, so
    // the count has to happen while the bytes arrive.
    const body = new Uint8Array(MCP_BODY_MAX_BYTES + 1).fill(0x61);
    const request = streamed(body);
    expect(request.headers.get('content-length')).toBeNull();
    expect(await readBoundedBody(request, MCP_BODY_MAX_BYTES)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('treats invalid UTF-8 as unreadable rather than substituting characters', async () => {
    // JSON-RPC messages must be UTF-8. Silent U+FFFD substitution would turn a
    // corrupt body into a valid-looking one.
    const read = await readBoundedBody(streamed(new Uint8Array([0x7b, 0xff, 0x7d])), 1024);
    expect(read).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reads an empty body as empty text', async () => {
    const read = await readBoundedBody(
      new Request('https://panel.test/mcp', { method: 'POST' }),
      8,
    );
    expect(read).toEqual({ ok: true, text: '' });
  });
});

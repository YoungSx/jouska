/**
 * Wire rules of the MCP Streamable HTTP transport, protocol revision 2026-07-28.
 *
 * Separated from the tool surface in `api/mcp.ts` because the two change for
 * different reasons: tools follow jouska's own config model, everything here
 * follows the spec — header/body agreement, the reserved error-code sub-range,
 * the required `_meta` envelope, and the caching hints a cacheable result must
 * carry.
 *
 * Modern-only, deliberately. The handshake revisions (`2025-11-25` and earlier)
 * open with `initialize`, and their clients send no `MCP-Protocol-Version`
 * header on that first request — so they can never reach a server that
 * requires it. Rather than advertise a revision nobody can reach, `initialize`
 * is answered with the version error the spec asks a modern-only server to
 * return: it names what this server speaks, which is the only diagnostic a
 * legacy client can put in front of its user.
 */
import { isPlainObject } from './validate.js';

export const MCP_VERSION = '2026-07-28';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [MCP_VERSION];

/** Self-reported and display-only: the spec forbids deciding anything on it. */
export const MCP_SERVER_INFO = { name: 'jouska', version: '0.2.2' } as const;

export const JSON_RPC = '2.0';

/**
 * JSON-RPC's own codes plus the two MCP-defined ones this transport emits.
 *
 * `-32020`..`-32099` belongs to the specification: an implementation must not
 * emit a code from that range that the spec has not defined. Insufficient
 * scope — which the spec answers at the HTTP layer with 403 rather than a
 * JSON-RPC code — therefore carries a code from outside the reserved range.
 */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const HEADER_MISMATCH = -32020;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const INSUFFICIENT_SCOPE = -32803;

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Cap on one MCP request body, enforced while reading — see `readBoundedBody`. */
export const MCP_BODY_MAX_BYTES = 256 * 1024;

/**
 * Cache hints for the results the spec calls cacheable, keyed by method so that
 * `rpcResult` applies them and a new cacheable method cannot ship without one.
 *
 * `tools/list` is `private` because the list is filtered by the calling token's
 * scopes: a shared cache would hand one token another's tools. `server/discover`
 * is the same answer for everyone, so it may be shared.
 */
const CACHE_HINTS: Record<
  string,
  { readonly ttlMs: number; readonly cacheScope: 'public' | 'private' }
> = {
  'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
};

export type RpcId = string | number;

/** MCP narrows JSON-RPC: an id may be a string or an integer, and never null. */
export const isRpcId = (value: unknown): value is RpcId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));

export const record = (value: unknown): Record<string, unknown> | undefined =>
  isPlainObject(value) ? value : undefined;

export const mcpJson = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });

/**
 * A successful result.
 *
 * `resultType`, the server identity and the caching hints are added here rather
 * than at each call site: all three are required of every result that carries
 * them, and a per-handler copy is a per-handler chance to forget one.
 */
export const rpcResult = (id: RpcId, method: string, result: Record<string, unknown>): Response =>
  mcpJson({
    jsonrpc: JSON_RPC,
    id,
    result: {
      resultType: 'complete',
      ...result,
      ...CACHE_HINTS[method],
      _meta: { ...record(result._meta), [META_SERVER_INFO]: MCP_SERVER_INFO },
    },
  });

export const rpcError = (
  id: RpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  mcpJson(
    {
      jsonrpc: JSON_RPC,
      ...(id === undefined ? {} : { id }),
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    status,
    extraHeaders,
  );

const SENTINEL_PREFIX = '=?base64?';
const SENTINEL_SUFFIX = '?=';

/**
 * A header value the client may have encoded.
 *
 * Tool names are only *recommended* to stay header-safe, so a client carries an
 * unsafe one in the `=?base64?…?=` sentinel form. The spec requires decoding
 * before comparing against the body, which is why an encoded name is a match
 * rather than a mismatch. `undefined` means "no usable value": an absent header,
 * and a value whose shape claims encoding but whose payload does not decode.
 * The latter is not treated as a literal — a client must encode any plain value
 * that already looks like the sentinel, so this shape is always a claim to have
 * encoded, and an unmet claim is malformed input rather than a name.
 */
export const decodeMcpHeaderValue = (raw: string | null): string | undefined => {
  if (raw === null) return undefined;
  if (!raw.startsWith(SENTINEL_PREFIX) || !raw.endsWith(SENTINEL_SUFFIX)) return raw;
  const payload = raw.slice(SENTINEL_PREFIX.length, -SENTINEL_SUFFIX.length);
  // Rejects a value short enough for the markers to overlap, e.g. `=?base64?=`.
  if (SENTINEL_PREFIX.length + payload.length + SENTINEL_SUFFIX.length !== raw.length) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return undefined;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** `application/json`, parameters and casing aside. Anything else is a 415. */
export const isJsonMediaType = (contentType: string | null): boolean =>
  contentType !== null && contentType.split(';')[0]!.trim().toLowerCase() === 'application/json';

export type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too_large' | 'unreadable' };

/**
 * Read at most `max` bytes of the request body, counting as they arrive.
 *
 * The count is the point. `content-length` is a claim, and a chunked upload
 * makes none at all — a body limit that reads the header and then hands the
 * whole stream to `json()` stops nothing. The header is still checked first,
 * because rejecting a declared oversize costs nothing.
 *
 * Decoding is fatal: JSON-RPC messages must be UTF-8, so invalid bytes are a
 * parse error rather than a silent run of U+FFFD.
 */
export const readBoundedBody = async (request: Request, max: number): Promise<BodyRead> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: 'too_large' };
  const body = request.body;
  if (body === null) return { ok: true, text: '' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined),
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
};

export interface McpEnvelope {
  /** Absent for a notification, which the transport answers with 202. */
  readonly id: RpcId | undefined;
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  /** Validated here for `tools/call`, so no handler has to assert it. */
  readonly toolName: string | undefined;
}

/**
 * Every check the transport owes the client before a handler runs, in the order
 * the spec puts them, returning the rejection response or the validated call.
 *
 * The header checks exist because intermediaries route on the headers while the
 * server executes the body: any disagreement between the two is a request that
 * two components would read differently, so it is refused rather than resolved.
 */
export const validateEnvelope = (request: Request, parsed: unknown): McpEnvelope | Response => {
  const body = record(parsed);
  if (body === undefined) {
    return rpcError(undefined, INVALID_REQUEST, 'Request must be a JSON object', undefined, 400);
  }
  const method = typeof body.method === 'string' ? body.method : undefined;
  const id = isRpcId(body.id) ? body.id : undefined;
  if (
    body.jsonrpc !== JSON_RPC ||
    method === undefined ||
    (body.id !== undefined && id === undefined)
  ) {
    return rpcError(id, INVALID_REQUEST, 'Invalid JSON-RPC request', undefined, 400);
  }
  const params = record(body.params);

  // A handshake-era client opens here and cannot have sent the version header.
  // Answer the version, not the missing header: naming what this server speaks
  // is the only thing such a client can surface to its user.
  if (method === 'initialize') {
    return rpcError(
      id,
      UNSUPPORTED_PROTOCOL_VERSION,
      `Unsupported protocol version: this server implements ${MCP_VERSION}, which has no initialize handshake`,
      {
        supported: MCP_SUPPORTED_VERSIONS,
        requested: typeof params?.protocolVersion === 'string' ? params.protocolVersion : null,
      },
      400,
    );
  }

  const version = request.headers.get('mcp-protocol-version');
  // Blank counts as missing, not as an unsupported version: an empty required
  // header is malformed input, which the spec answers with the header error.
  if (version === null || version.trim() === '') {
    return rpcError(
      id,
      HEADER_MISMATCH,
      'Missing required MCP-Protocol-Version header',
      { supported: MCP_SUPPORTED_VERSIONS },
      400,
    );
  }
  if (!MCP_SUPPORTED_VERSIONS.includes(version)) {
    return rpcError(
      id,
      UNSUPPORTED_PROTOCOL_VERSION,
      'Unsupported protocol version',
      { supported: MCP_SUPPORTED_VERSIONS, requested: version },
      400,
    );
  }
  const meta = record(params?._meta);
  if (meta?.[META_PROTOCOL_VERSION] === undefined) {
    return rpcError(
      id,
      INVALID_PARAMS,
      `Missing required _meta.${META_PROTOCOL_VERSION}`,
      undefined,
      400,
    );
  }
  if (meta[META_PROTOCOL_VERSION] !== version) {
    return rpcError(
      id,
      HEADER_MISMATCH,
      'MCP-Protocol-Version header does not match request metadata',
      undefined,
      400,
    );
  }
  if (!isPlainObject(meta[META_CLIENT_CAPABILITIES])) {
    return rpcError(
      id,
      INVALID_PARAMS,
      `Missing required _meta.${META_CLIENT_CAPABILITIES}`,
      undefined,
      400,
    );
  }
  if (request.headers.get('mcp-method') !== method) {
    return rpcError(
      id,
      HEADER_MISMATCH,
      'Mcp-Method header does not match request method',
      undefined,
      400,
    );
  }
  if (method === 'tools/call') {
    if (typeof params?.name !== 'string') {
      return rpcError(id, INVALID_PARAMS, 'Tool name is required', undefined, 400);
    }
    if (decodeMcpHeaderValue(request.headers.get('mcp-name')) !== params.name) {
      return rpcError(
        id,
        HEADER_MISMATCH,
        'Mcp-Name header does not match tool name',
        undefined,
        400,
      );
    }
    return { id, method, params, toolName: params.name };
  }
  return { id, method, params, toolName: undefined };
};

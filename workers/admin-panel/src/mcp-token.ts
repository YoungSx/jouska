import { boundedString } from './validate.js';

export const MCP_TOKEN_PREFIX = 'jska_mcp_';
export const MCP_TOKEN_BYTES = 32;
export const MCP_TOKEN_MAX_LENGTH = MCP_TOKEN_PREFIX.length + 43;
export const MCP_TOKEN_DEFAULT_DAYS = 90;
export const MCP_TOKEN_MAX_DAYS = 365;

export const MCP_SCOPES = ['config:read', 'config:write', 'domains:read', 'audit:read'] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

const encoder = new TextEncoder();

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const createMcpToken = (): { token: string; prefix: string } => {
  const token = `${MCP_TOKEN_PREFIX}${base64Url(crypto.getRandomValues(new Uint8Array(MCP_TOKEN_BYTES)))}`;
  return { token, prefix: token.slice(0, MCP_TOKEN_PREFIX.length + 8) };
};

export const createMcpTokenId = (): string => base64Url(crypto.getRandomValues(new Uint8Array(12)));

export const parseScopes = (value: unknown): McpScope[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    return undefined;
  }
  const scopes = value.filter((entry): entry is McpScope =>
    (MCP_SCOPES as readonly string[]).includes(entry as string),
  );
  return scopes.length === value.length ? scopes : undefined;
};

export const normalizeTokenName = (value: unknown): string | undefined => boundedString(value, 128);

export const tokenLooksValid = (value: string): boolean => {
  if (value.length !== MCP_TOKEN_MAX_LENGTH || !value.startsWith(MCP_TOKEN_PREFIX)) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(value.slice(MCP_TOKEN_PREFIX.length));
};

export const actorForMcp = (tokenId: string, subject: string): string =>
  `mcp:${tokenId}:${subject}`;

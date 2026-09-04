/** Dashboard lifecycle API for machine credentials used by `/mcp`. */
import { Hono } from 'hono';
import { requireAdmin } from '../middleware.js';
import type { AppEnv } from '../env.js';
import { audit, insertMcpToken, listMcpTokens, revokeMcpToken } from '../store.js';
import { readJsonObject } from '../body.js';
import {
  createMcpToken,
  createMcpTokenId,
  MCP_TOKEN_DEFAULT_DAYS,
  MCP_TOKEN_MAX_DAYS,
  normalizeTokenName,
  parseScopes,
  sha256Hex,
  type McpScope,
} from '../mcp-token.js';
import { boundedString } from '../validate.js';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const mcpTokenRoutes = new Hono<AppEnv>();

// Token metadata is sensitive enough that viewers must not enumerate it.
mcpTokenRoutes.get('/mcp-tokens', requireAdmin, async (c) => {
  c.header('cache-control', 'no-store');
  return c.json({ tokens: await listMcpTokens(c.env.DB) });
});

mcpTokenRoutes.post('/mcp-tokens', requireAdmin, async (c) => {
  c.header('cache-control', 'no-store');
  const body = await readJsonObject(c);
  const name = normalizeTokenName(body.name);
  const requestedScopes =
    body.scopes === undefined ? (['config:read'] as const) : parseScopes(body.scopes);
  const scopes = requestedScopes === undefined ? undefined : [...requestedScopes];
  const days = body.expiresInDays === undefined ? MCP_TOKEN_DEFAULT_DAYS : body.expiresInDays;
  if (
    name === undefined ||
    scopes === undefined ||
    scopes.length === 0 ||
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > MCP_TOKEN_MAX_DAYS
  ) {
    return c.json(
      {
        error: 'invalid_input',
        detail: `name, scopes and expiresInDays (1-${MCP_TOKEN_MAX_DAYS}) are required`,
      },
      400,
    );
  }
  // Write permission is deliberately never enough to publish. The publish
  // endpoint remains Cookie + admin + human confirmation only.
  if (scopes.includes('config:write' as McpScope) && !scopes.includes('config:read' as McpScope)) {
    scopes.unshift('config:read');
  }
  const createdAt = nowSeconds();
  const expiresAt = createdAt + days * 24 * 60 * 60;
  const generated = createMcpToken();
  const id = createMcpTokenId();
  const user = c.get('user');
  await insertMcpToken(c.env.DB, {
    id,
    hash: await sha256Hex(generated.token),
    prefix: generated.prefix,
    name,
    ownerUserId: user.userId,
    issuedByUserId: user.userId,
    scopes,
    createdAt,
    expiresAt,
  });
  await audit(c.env.DB, user.subject, 'mcp.token.create', id, {
    name,
    scopes,
    expiresAt,
  });
  return c.json(
    {
      token: generated.token,
      tokenInfo: {
        id,
        name,
        tokenPrefix: generated.prefix,
        ownerUserId: user.userId,
        issuedByUserId: user.userId,
        ownerSubject: user.subject,
        scopes,
        createdAt,
        expiresAt,
        revokedAt: null,
        revokeReason: null,
        lastUsedAt: null,
      },
    },
    201,
  );
});

mcpTokenRoutes.delete('/mcp-tokens/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const body = await readJsonObject(c);
  const reason = body.reason === undefined ? null : boundedString(body.reason, 500);
  if (body.reason !== undefined && reason === undefined) {
    return c.json({ error: 'invalid_input', detail: 'reason must be at most 500 characters' }, 400);
  }
  const user = c.get('user');
  const revoked = await revokeMcpToken(c.env.DB, id, user.userId, nowSeconds(), reason ?? null);
  if (!revoked) {
    return c.json({ error: 'not_found' }, 404);
  }
  await audit(
    c.env.DB,
    user.subject,
    'mcp.token.revoke',
    id,
    reason === null ? undefined : { reason },
  );
  return c.json({ ok: true });
});

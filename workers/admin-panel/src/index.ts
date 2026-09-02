/**
 * Admin panel worker.
 *
 * wrangler's `run_worker_first` sends API and MCP traffic here;
 * every other path is served from the static assets (SPA mode), so the
 * worker never routes static files. Single worker, single origin: the panel
 * and its API cannot drift apart on CORS or cookies.
 */
import { Hono } from 'hono';
import { authRoutes } from './api/auth.js';
import { configRoutes } from './api/config.js';
import { domainRoutes } from './api/domains.js';
import { mcpRoutes } from './api/mcp.js';
import { mcpTokenRoutes } from './api/mcp-tokens.js';
import { revisionRoutes } from './api/revisions.js';
import { userRoutes } from './api/users.js';
import { requireSameOrigin, requireUser } from './middleware.js';
import type { AppEnv } from './env.js';

const app = new Hono<AppEnv>();

app.onError((error, c) => {
  console.error('admin-panel: unhandled error', error);
  return c.json({ error: 'internal_error' }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true }));

// MCP is a separate Bearer-only protocol surface. It must not pass through
// the Cookie/CSRF middleware used by the browser API.
app.route('/', mcpRoutes);

// CSRF: every non-GET must be same-origin, login included.
app.use('/api/*', requireSameOrigin);

app.route('/api/auth', authRoutes);

// Everything below is authenticated; admin-only writes are gated next to
// their handlers in api/config.ts, so viewers keep read access.
app.use('/api/*', requireUser);

app.route('/api', configRoutes);
app.route('/api', domainRoutes);
app.route('/api', userRoutes);
app.route('/api', revisionRoutes);
app.route('/api', mcpTokenRoutes);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return await app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;

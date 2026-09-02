/**
 * Configuration endpoints: route CRUD, ordering, defaults, preview, publish.
 *
 * Publish is the only write to KV, and it is guarded three times: the document
 * must compile and validate (`configSchema`), dangerous switches require an
 * explicit `confirm`, and everything lands in the audit log. One publish is
 * exactly one KV write — the free tier's daily write allowance is not to be
 * sprayed.
 */
import { Hono } from 'hono';
import { readJsonObject } from '../body.js';
import { previewDraft, type PreviewResult } from '../preview.js';
import { publishDraft } from '../publish.js';
import { requireAdmin } from '../middleware.js';
import {
  audit,
  deleteRoute,
  getRoute,
  getSetting,
  listAllRoutes,
  listAudit,
  putSetting,
  reorderRoutes,
  upsertRoute,
} from '../store.js';
import type { AppEnv } from '../env.js';
import {
  boundedInteger,
  boundedString,
  isPlainObject,
  jsonByteLength,
  MAX_DEFAULTS_BYTES,
  MAX_DEFINITION_BYTES,
  MAX_NOTE_LENGTH,
  routeIdFrom,
  strictBoolean,
} from '../validate.js';

export const configRoutes = new Hono<AppEnv>();

/** All routes, including disabled ones, in publish order. */
configRoutes.get('/routes', async (c) => {
  return c.json({ routes: await listAllRoutes(c.env.DB) });
});

// Writes are admin-only (gated per handler, not per prefix, so GETs stay
// viewer-readable); reads are available to any signed-in user.
configRoutes.put('/routes/:id', requireAdmin, async (c) => {
  const id = routeIdFrom(c.req.param('id'));
  if (id === undefined) {
    return c.json({ error: 'invalid_route_id' }, 400);
  }
  const body = await readJsonObject(c);
  // An array is an object to `typeof` but never a route; reject it by shape.
  if (!isPlainObject(body.definition)) {
    return c.json({ error: 'invalid_input', detail: 'definition must be a JSON object' }, 400);
  }
  const size = jsonByteLength(body.definition);
  if (size === undefined || size > MAX_DEFINITION_BYTES) {
    return c.json(
      {
        error: 'invalid_input',
        detail: `definition must serialize to at most ${MAX_DEFINITION_BYTES} bytes`,
      },
      400,
    );
  }
  const existing = await getRoute(c.env.DB, id);
  // Strict boolean: `enabled: 'yes'` reads as false to `=== true`, which would
  // silently park the route out of production on a typo. Reject instead.
  // Omitted keeps the route's current state — defaulting to `true` would let an
  // edit to a disabled route push it into production traffic as a side effect.
  const enabled =
    body.enabled === undefined ? (existing?.enabled ?? true) : strictBoolean(body.enabled);
  if (enabled === undefined) {
    return c.json({ error: 'invalid_input', detail: 'enabled must be a boolean' }, 400);
  }
  // New routes append at the end; position is managed, not authored.
  const position =
    existing === undefined ? (await listAllRoutes(c.env.DB)).length : existing.position;
  const user = c.get('user');
  await upsertRoute(c.env.DB, id, body.definition, enabled, position, user.subject);
  await audit(
    c.env.DB,
    user.subject,
    existing === undefined ? 'route.create' : 'route.update',
    id,
    {
      definition: body.definition,
      enabled,
    },
  );
  return c.json({ ok: true });
});

configRoutes.delete('/routes/:id', requireAdmin, async (c) => {
  const id = routeIdFrom(c.req.param('id'));
  if (id === undefined) {
    return c.json({ error: 'invalid_route_id' }, 400);
  }
  const existing = await getRoute(c.env.DB, id);
  if (existing === undefined) {
    return c.json({ error: 'not_found' }, 404);
  }
  const user = c.get('user');
  await deleteRoute(c.env.DB, id);
  await audit(c.env.DB, user.subject, 'route.delete', id, { definition: existing.definition });
  return c.json({ ok: true });
});

configRoutes.put('/routes-order', requireAdmin, async (c) => {
  const body = await readJsonObject(c);
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) {
    return c.json({ error: 'invalid_input', detail: 'ids must be an array of route ids' }, 400);
  }
  const ids = body.ids as string[];
  const known = new Set((await listAllRoutes(c.env.DB)).map((r) => r.id));
  // A permutation, checked as one: right length, all known, and no duplicates.
  // Without the duplicate check `['a','a']` passes the first two and leaves
  // some other route unpositioned — the table has no uniqueness constraint on
  // position, so the drift would persist silently into every compile.
  if (
    ids.length !== known.size ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => known.has(id))
  ) {
    return c.json(
      { error: 'invalid_input', detail: 'ids must be a permutation of all route ids' },
      400,
    );
  }
  const user = c.get('user');
  await reorderRoutes(c.env.DB, ids, user.subject);
  await audit(c.env.DB, user.subject, 'routes.reorder', undefined, { ids });
  return c.json({ ok: true });
});

configRoutes.get('/defaults', async (c) => {
  return c.json({ defaults: (await getSetting(c.env.DB, 'defaults')) ?? null });
});

configRoutes.put('/defaults', requireAdmin, async (c) => {
  const body = await readJsonObject(c);
  if (!isPlainObject(body.defaults)) {
    return c.json({ error: 'invalid_input', detail: 'defaults must be a JSON object' }, 400);
  }
  const size = jsonByteLength(body.defaults);
  if (size === undefined || size > MAX_DEFAULTS_BYTES) {
    return c.json(
      {
        error: 'invalid_input',
        detail: `defaults must serialize to at most ${MAX_DEFAULTS_BYTES} bytes`,
      },
      400,
    );
  }
  const user = c.get('user');
  await putSetting(c.env.DB, 'defaults', body.defaults);
  await audit(c.env.DB, user.subject, 'defaults.update', undefined, { defaults: body.defaults });
  return c.json({ ok: true });
});

/** Dry-run: compile, validate, shadow- and mirror-check — no KV write. */
configRoutes.get('/preview', async (c) => {
  return c.json<PreviewResult>(await previewDraft(c.env.DB));
});

/**
 * Publish: compile, validate, gate on dangers, one KV write, audit.
 *
 * The pipeline itself lives in `publish.ts` — rollback must run the exact same
 * gates, so this handler only maps the shared outcome onto HTTP.
 */
configRoutes.post('/publish', requireAdmin, async (c) => {
  const body = await readJsonObject(c);
  const user = c.get('user');
  const note = boundedString(body.note, MAX_NOTE_LENGTH);
  const result = await publishDraft(c.env, {
    actor: user.subject,
    ...(note === undefined ? {} : { note }),
    confirm: body.confirm === true,
    action: 'config.publish',
  });
  if (!result.ok) {
    if (result.reason === 'already_live') {
      // 客户端的 gate 可能是陈旧的（另一标签页刚发布过），所以 409 不只是给
      // 双击兜底——它是唯一靠得住的 no-op 拦截点。
      return c.json({ ok: false, error: 'already_live' }, 409);
    }
    return result.reason === 'compile_failed'
      ? c.json<PreviewResult>(
          {
            ok: false,
            issues: result.issues,
            ...(result.empty === true ? { empty: true } : {}),
          },
          422,
        )
      : c.json<PreviewResult>(
          {
            ok: false,
            dangers: result.dangers,
            shadowWarnings: result.shadowWarnings,
            mirrorWarnings: result.mirrorWarnings,
            error: 'confirmation_required',
          },
          409,
        );
  }
  return c.json({
    ok: true,
    revision: result.revision,
    shadowWarnings: result.shadowWarnings,
    mirrorWarnings: result.mirrorWarnings,
    dangers: result.dangers,
  });
});

configRoutes.get('/audit', async (c) => {
  // Fractions reach SQLite as `LIMIT 1.5` (an error) and negatives as
  // `LIMIT -5` (silently unbounded, dumping the whole log); both fall back.
  const limit = boundedInteger(c.req.query('limit'), 50, 200);
  return c.json({ entries: await listAudit(c.env.DB, limit) });
});

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
import { compileConfig, type RouteRow } from '../compile.js';
import { dangerFlags, type FieldRisk } from '../danger.js';
import { asLiveState, documentDigest, LIVE_KEY } from '../fingerprint.js';
import { publishDraft } from '../publish.js';
import { requireAdmin } from '../middleware.js';
import {
  audit,
  deleteRoute,
  getRoute,
  getSetting,
  listAllRoutes,
  listAudit,
  listEnabledRoutes,
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
  strictBoolean,
} from '../validate.js';

export interface PreviewResult {
  readonly ok: boolean;
  readonly issues?: readonly { routeId: string | undefined; path: string; message: string }[];
  readonly shadowWarnings?: readonly { shadowedId: string; byId: string; probe: string }[];
  readonly dangers?: Record<string, readonly FieldRisk[]>;
  readonly document?: unknown;
  readonly routeCount?: number;
  readonly error?: string;
  /**
   * Nothing to publish yet, as opposed to something wrong. A fresh deployment
   * is `ok: false, empty: true` — the UI guides instead of alarming.
   */
  readonly empty?: true;
  /**
   * What the proxy is serving right now, and whether the draft differs from it.
   *
   * Present on every preview, including a failing one: an operator looking at a
   * broken draft still needs to know that the previous revision is live and
   * unaffected. `undefined` live means nothing has ever been published.
   */
  readonly live?: { readonly revision: number } | null;
  readonly dirty?: boolean;
}

const routeIdFrom = (raw: string | undefined): string | undefined =>
  raw !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw) ? raw : undefined;

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
  // Strict boolean: `enabled: 'yes'` reads as false to `=== true`, which would
  // silently park the route out of production on a typo. Reject instead.
  const enabled = body.enabled === undefined ? true : strictBoolean(body.enabled);
  if (enabled === undefined) {
    return c.json({ error: 'invalid_input', detail: 'enabled must be a boolean' }, 400);
  }
  const existing = await getRoute(c.env.DB, id);
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

/** Dry-run: compile, validate, shadow-check — no KV write. */
configRoutes.get('/preview', async (c) => {
  const rows: RouteRow[] = await listEnabledRoutes(c.env.DB);
  const defaults = await getSetting(c.env.DB, 'defaults');
  const live = asLiveState(await getSetting(c.env.DB, LIVE_KEY));
  const liveField = live === undefined ? null : { revision: live.revision };
  const compiled = compileConfig(rows, defaults);
  if (!compiled.ok) {
    return c.json<PreviewResult>({
      ok: false,
      issues: compiled.issues,
      ...(compiled.empty === true ? { empty: true } : {}),
      live: liveField,
      // A draft that will not compile can never equal what is live, so it is
      // dirty by definition — unless nothing was ever published and the draft
      // is empty, which is the untouched first-run state, not a pending change.
      dirty: !(compiled.empty === true && live === undefined),
    });
  }
  const dangers: Record<string, readonly FieldRisk[]> = {};
  for (const row of rows) {
    if (typeof row.definition === 'object' && row.definition !== null) {
      const flags = dangerFlags(row.definition as Record<string, unknown>);
      if (flags.length > 0) {
        dangers[row.id] = flags;
      }
    }
  }
  // Digest the same document publish would write, minus `meta` — see
  // fingerprint.ts for why `meta` is excluded.
  const digest = await documentDigest(compiled.document);
  return c.json<PreviewResult>({
    ok: true,
    document: compiled.document,
    shadowWarnings: compiled.shadowWarnings,
    dangers,
    routeCount: rows.length,
    live: liveField,
    dirty: live === undefined || live.digest !== digest,
  });
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
            error: 'confirmation_required',
          },
          409,
        );
  }
  return c.json({
    ok: true,
    revision: result.revision,
    shadowWarnings: result.shadowWarnings,
    dangers: result.dangers,
  });
});

configRoutes.get('/audit', async (c) => {
  // Fractions reach SQLite as `LIMIT 1.5` (an error) and negatives as
  // `LIMIT -5` (silently unbounded, dumping the whole log); both fall back.
  const limit = boundedInteger(c.req.query('limit'), 50, 200);
  return c.json({ entries: await listAudit(c.env.DB, limit) });
});

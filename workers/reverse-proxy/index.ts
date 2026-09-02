/**
 * Reference Worker.
 *
 * The library itself ships no Worker: it is middleware, and how the pieces are
 * assembled is a deployment decision. This is that decision made once, in the
 * way the README recommends, so there is something deployable to look at and
 * copy from.
 *
 * Config comes from KV when a namespace is bound, falling back to a plain
 * environment variable, with a code-defined table winning either way. The
 * resolved config is cached in isolate memory so the store is read once per TTL
 * rather than once per request.
 *
 * Observability receivers (Analytics Engine, access logs) are optional and live
 * in `observability.ts`; with nothing bound, `onProxy` is never installed.
 */
import { Hono } from 'hono';
import {
  createConfigCache,
  firstAvailable,
  fromEnvVar,
  fromKV,
  jouska,
  resolveConfig,
  type Config,
  type ConfigCache,
  type ConfigSource,
  type KVReader,
} from 'jouska';

import { createProxySink, type ProxySink } from './observability.js';

export interface Env {
  /** Optional KV namespace holding the route table under CONFIG_KEY. */
  CONFIG?: KVReader;
  /** Key to read from the KV namespace. Defaults to `routes`. */
  CONFIG_KEY?: string;
  /** Route table as a JSON document, for deployments without KV. */
  JOUSKA_CONFIG?: unknown;
  /**
   * Optional Analytics Engine dataset. When bound, one data point per proxied
   * request is written for per-route latency and error-rate queries.
   */
  ANALYTICS?: AnalyticsEngineDataset;
  /** Set to `"true"` to emit a structured log line per proxied request. */
  ACCESS_LOGS?: string;
}

/**
 * Test-only seam. Kept off `Env` so a production binding cannot supply it: an
 * environment variable that replaces the upstream fetch would be an arbitrary
 * request redirector, and there is no reason for it to exist outside tests.
 */
export interface TestOverrides {
  UPSTREAM_FETCH?: typeof fetch;
}

/**
 * Routes defined in code. These win over anything in the store, which makes
 * them the escape hatch when a stored table is wrong or unreachable.
 *
 * Left empty deliberately: an operator of this reference Worker configures
 * routes through KV or the environment variable rather than by editing source.
 */
const CODE_ROUTES: Config['routes'] | undefined = undefined;

const buildSource = (env: Env): ConfigSource => {
  const sources: ConfigSource[] = [];
  if (env.CONFIG !== undefined) {
    // 30 is KV's minimum; this only lowers latency, not billed reads.
    sources.push(fromKV(env.CONFIG, env.CONFIG_KEY ?? 'routes', { cacheTtlSeconds: 60 }));
  }
  sources.push(fromEnvVar(env, 'JOUSKA_CONFIG'));
  return firstAvailable(sources, (error, index) =>
    console.error(`jouska: config source ${index} failed`, error),
  );
};

/**
 * Module scope, so the cache and the assembled app survive between requests in
 * the same isolate.
 *
 * The cache is keyed by the bindings it was built from rather than closing over
 * whichever `env` happened to arrive first. Capturing that first `env` would pin
 * the isolate to it: a cold start during a brief KV outage would leave that
 * isolate serving 503 for its whole life, even once the store recovered. Keying
 * also means a binding change produces a fresh cache instead of silently reusing
 * a loader that reads the old namespace.
 */
interface CachedState {
  key: string;
  cache: ConfigCache;
}

let state: CachedState | undefined;

/**
 * The assembled app, rebuilt only when the config changes.
 *
 * Rebuilding per request meant allocating a Hono instance and re-registering the
 * middleware on every hit — pure overhead, since neither depends on the request.
 */
let app: Hono | undefined;
let appConfig: Config | undefined;
let appFetch: typeof fetch | undefined;
let appSink: ProxySink | undefined;

/**
 * The observability fan-out, cached the same way the app is: cheap to build,
 * but its identity must be stable or the app would be rebuilt per request.
 * Keyed on the actual bindings rather than their presence, so swapping a
 * dataset or flipping `ACCESS_LOGS` swaps the sink too.
 */
let sink: ProxySink | undefined;
let sinkAnalytics: AnalyticsEngineDataset | undefined;
let sinkAccessLogs: string | undefined;

const getSink = (env: Env): ProxySink | undefined => {
  if (sinkAnalytics !== env.ANALYTICS || sinkAccessLogs !== env.ACCESS_LOGS) {
    sink = createProxySink(env);
    sinkAnalytics = env.ANALYTICS;
    sinkAccessLogs = env.ACCESS_LOGS;
  }
  return sink;
};

/** Identifies the bindings a loader would read, so a change invalidates it. */
const bindingKey = (env: Env): string =>
  JSON.stringify([
    env.CONFIG !== undefined,
    env.CONFIG_KEY ?? 'routes',
    env.JOUSKA_CONFIG !== undefined,
  ]);

const getConfig = (env: Env): Promise<Config> => {
  const key = bindingKey(env);
  if (state?.key !== key) {
    state = {
      key,
      cache: createConfigCache({
        load: async () =>
          resolveConfig({
            ...(CODE_ROUTES !== undefined ? { code: { routes: CODE_ROUTES } } : {}),
            remote: await buildSource(env)(),
            merge: 'byId',
            onRemoteError: (error) => console.error('jouska: stored config rejected', error),
          }),
        onReloadError: (error) => console.error('jouska: config reload failed', error),
      }),
    };
  }
  return state.cache.get();
};

/**
 * Discards the module-scope cache. Exported for tests, which need each case to
 * start from a cold isolate; a deployment gets that for free because binding
 * changes restart the isolate anyway.
 */
export const __resetConfigCache = (): void => {
  state = undefined;
  app = undefined;
  appConfig = undefined;
  appFetch = undefined;
  sink = undefined;
  sinkAnalytics = undefined;
  sinkAccessLogs = undefined;
};

const getApp = (
  config: Config,
  fetchImpl: typeof fetch | undefined,
  proxySink: ProxySink | undefined,
): Hono => {
  if (
    app === undefined ||
    appConfig !== config ||
    appFetch !== fetchImpl ||
    appSink !== proxySink
  ) {
    const next = new Hono();
    next.use(
      '*',
      jouska({
        config,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(proxySink ? { onProxy: proxySink } : {}),
      }),
    );
    app = next;
    appConfig = config;
    appFetch = fetchImpl;
    appSink = proxySink;
  }
  return app;
};

export default {
  async fetch(
    request: Request,
    env: Env & TestOverrides,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let config: Config;
    try {
      config = await getConfig(env);
    } catch (error) {
      // No usable config means no routes, so say so plainly instead of
      // returning a confusing 404 from an empty table.
      console.error('jouska: no usable config', error);
      return Response.json({ error: 'config_unavailable' }, { status: 503 });
    }
    return getApp(config, env.UPSTREAM_FETCH, getSink(env)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

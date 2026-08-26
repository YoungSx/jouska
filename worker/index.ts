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
} from '../src/index.js';

interface Env {
  /** Optional KV namespace holding the route table under CONFIG_KEY. */
  CONFIG?: KVReader;
  /** Key to read from the KV namespace. Defaults to `routes`. */
  CONFIG_KEY?: string;
  /** Route table as a JSON document, for deployments without KV. */
  JOUSKA_CONFIG?: unknown;
  /**
   * Overrides the upstream fetch. Only set by tests, so they can exercise the
   * wiring against a controlled origin instead of the public network.
   */
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
 * Module scope, so the cache survives between requests in the same isolate.
 *
 * The loader reads `latestEnv` rather than closing over the `env` of whichever
 * request happened to create the cache. Capturing that first `env` would pin the
 * isolate to it forever: a cold start during a brief KV outage would leave that
 * isolate returning 503 for its whole life, even once the store recovered.
 */
let cache: ConfigCache | undefined;
let latestEnv: Env = {};

const getConfig = (env: Env): Promise<Config> => {
  latestEnv = env;
  cache ??= createConfigCache({
    load: async () =>
      resolveConfig({
        ...(CODE_ROUTES !== undefined ? { code: { routes: CODE_ROUTES } } : {}),
        remote: await buildSource(latestEnv)(),
        merge: 'byId',
        onRemoteError: (error) => console.error('jouska: stored config rejected', error),
      }),
    onReloadError: (error) => console.error('jouska: config reload failed', error),
  });
  return cache.get();
};

/**
 * Discards the module-scope cache. Exported for tests, which need each case to
 * start from a cold isolate; a deployment gets that for free because binding
 * changes restart the isolate anyway.
 */
export const __resetConfigCache = (): void => {
  cache = undefined;
  latestEnv = {};
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let config: Config;
    try {
      config = await getConfig(env);
    } catch (error) {
      // No usable config means no routes, so say so plainly instead of
      // returning a confusing 404 from an empty table.
      console.error('jouska: no usable config', error);
      return Response.json({ error: 'config_unavailable' }, { status: 503 });
    }

    const app = new Hono();
    app.use(
      '*',
      jouska({ config, ...(env.UPSTREAM_FETCH ? { fetchImpl: env.UPSTREAM_FETCH } : {}) }),
    );
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

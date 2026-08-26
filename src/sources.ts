/**
 * Config sources.
 *
 * Every source resolves to "some unvalidated value" which `resolveConfig` then
 * validates. Keeping them this thin means a new backing store is a few lines,
 * not a new abstraction.
 */

/** Anything that can hand back a stored config document. */
export type ConfigSource = () => Promise<unknown>;

/**
 * Reads config from a plain-text environment variable.
 *
 * Both shapes a Worker can receive are accepted, because they are not
 * interchangeable in practice: a `vars` entry declared as a JSON object in
 * wrangler config arrives as an object, while a variable added by hand in the
 * Cloudflare dashboard can only ever be a string. Verified against workerd.
 *
 * Note the trade-off before choosing this over KV: environment variables are
 * deployment configuration, not data. Changing one means redeploying the
 * Worker, there is no history, and a dashboard edit can be overwritten by a
 * later `wrangler deploy` that does not carry the same value. Use it for a
 * table that changes with the code, and KV for one edited at runtime.
 */
export const fromEnvVar = (env: unknown, name: string): ConfigSource => {
  return async () => {
    const value = (env as Record<string, unknown> | undefined)?.[name];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'string') {
      // Already an object: wrangler parsed the JSON at deploy time.
      return value;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      return undefined;
    }
    // A malformed string is thrown, not swallowed: the caller decides whether
    // that is fatal (code source) or recoverable (remote source).
    return JSON.parse(trimmed) as unknown;
  };
};

/** The subset of a KV namespace binding this code depends on. */
export interface KVReader {
  get(key: string, options: { type: 'json' }): Promise<unknown>;
}

export interface KVSourceOptions {
  /**
   * Seconds the value may be served from Cloudflare's edge cache. A cache hit
   * does not count against the KV read allowance, so this compounds with
   * `createConfigCache` to keep reads near zero. Bounded by how stale the
   * config may be.
   */
  cacheTtlSeconds?: number;
}

/**
 * Reads config from a KV namespace. The stored value must be a JSON document;
 * `type: 'json'` makes KV parse it, so a malformed document surfaces here
 * rather than as a confusing validation error later.
 */
export const fromKV = (
  namespace: KVReader,
  key: string,
  { cacheTtlSeconds }: KVSourceOptions = {},
): ConfigSource => {
  return async () =>
    namespace.get(key, {
      type: 'json',
      ...(cacheTtlSeconds !== undefined ? { cacheTtl: cacheTtlSeconds } : {}),
    } as { type: 'json' });
};

/**
 * Tries each source in order and returns the first that yields a value.
 *
 * Use this to layer stores without giving up either: a KV document edited by a
 * panel takes precedence, with an environment variable as the fallback that
 * ships with the deployment. A source that throws is treated as absent so one
 * broken store cannot mask a working one; the error reaches `onError`.
 */
export const firstAvailable = (
  sources: readonly ConfigSource[],
  onError?: (error: unknown, index: number) => void,
): ConfigSource => {
  return async () => {
    for (const [index, source] of sources.entries()) {
      let value: unknown;
      try {
        // Sequential by design: a later source is only consulted when the
        // earlier one has nothing, so this must not run in parallel.
        // oxlint-disable-next-line no-await-in-loop
        value = await source();
      } catch (error) {
        onError?.(error, index);
        continue;
      }
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return undefined;
  };
};

export { createConfigCache } from './cache.js';
export type { CacheOptions, ConfigCache } from './cache.js';
export { CONFIG_VERSION, configSchema, defineConfig } from './config.js';
export type {
  BodyRewriteConfig,
  Config,
  ConfigInput,
  ConfigMeta,
  CorsConfig,
  RateLimitConfig,
  Route,
  RouteInput,
} from './config.js';
export { resolveConfig } from './resolve.js';
// Match diagnostics: an admin panel validates a route table with the same
// matcher the proxy runs (shadow detection, probe checks), so the matcher must
// be importable rather than reimplemented beside it.
export { matchUrl, routeId, splitUpstream } from './router.js';
export type { Match } from './router.js';
export { firstAvailable, fromEnvVar, fromKV } from './sources.js';
export type { ConfigSource, KVReader, KVSourceOptions } from './sources.js';
export type { MergeStrategy, ResolveOptions } from './resolve.js';
export { jouska } from './middleware/jouska.js';
export type { JouskaOptions, ProxyEvent, RewriteSkipReason } from './middleware/jouska.js';

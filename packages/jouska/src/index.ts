export { createConfigCache } from './cache.js';
export type { CacheOptions, ConfigCache } from './cache.js';
export { CONFIG_VERSION, configSchema, defineConfig } from './config.js';
export type {
  BodyRewriteConfig,
  CacheConfig,
  Config,
  ConfigInput,
  ConfigMeta,
  CorsConfig,
  HeaderRulesConfig,
  RateLimitConfig,
  Route,
  RouteInput,
} from './config.js';
export { resolveConfig } from './resolve.js';
// Match diagnostics: an admin panel validates a route table with the same
// matcher the proxy runs (shadow detection, probe checks), so the matcher must
// be importable rather than reimplemented beside it. `upstreamCandidates`
// belongs with it: a panel that explains a route shows the walk order too.
export { matchUrl, routeId, splitUpstream, upstreamCandidates } from './router.js';
export type { Match } from './router.js';
export { firstAvailable, fromEnvVar, fromKV } from './sources.js';
export type { ConfigSource, KVReader, KVSourceOptions } from './sources.js';
export type { MergeStrategy, ResolveOptions } from './resolve.js';
export { jouska } from './middleware/jouska.js';
export type { JouskaOptions, ProxyEvent, RewriteSkipReason } from './middleware/jouska.js';
// Response-cache surface a host needs: the state names that appear on
// `ProxyEvent.cache` and in the `x-jouska-cache` header, and the store shape for
// a deployment that supplies its own cache rather than `caches.default`.
export { CACHE_STATE_HEADER } from './internal/response-cache.js';
export type { CacheState, ResponseCacheStore } from './internal/response-cache.js';
// `ProxyEvent.selection` references it, so consumers typing their `onProxy`
// need the shape even though the picker itself stays internal.
export type { Selection } from './internal/selection.js';

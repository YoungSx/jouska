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
  ForwardAuthConfig,
  HeaderRulesConfig,
  MirrorConfig,
  RateLimitConfig,
  RequestIdConfig,
  Route,
  RouteInput,
} from './config.js';
export { resolveConfig } from './resolve.js';
// Timing presets are documentation-shaped data: the panel imports them to fill
// form fields, hand-written JSON copies them from the README, and a unit test
// keeps the two copies from drifting. Nothing at request time reads them.
export { TIMING_PRESETS } from './presets.js';
export type { TimingPreset, TimingPresetName } from './presets.js';
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
export type {
  JouskaOptions,
  LimitReason,
  ProxyEvent,
  RewriteSkipReason,
} from './middleware/jouska.js';
// Cloudflare Access JWT verification, shared with the admin panel: the panel
// runs behind Access on a Static-Assets Worker, where `ctx.access` is never
// populated, so verifying this header is the only way it learns who called.
// The proxy's route-level guard is built on the same function — a second,
// approximate verifier next to this one is exactly what sharing prevents.
export { verifyAccessJwt } from './internal/access.js';
export type { AccessClaims, AccessJwtRefusal, AccessJwtResult } from './internal/access.js';
// Response-cache surface a host needs: the state names that appear on
// `ProxyEvent.cache` and in the `x-jouska-cache` header, and the store shape for
// a deployment that supplies its own cache rather than `caches.default`.
export { CACHE_STATE_HEADER } from './internal/response-cache.js';
export type { CacheState, ResponseCacheStore } from './internal/response-cache.js';
// `ProxyEvent.stream` resolves to one of these, so a host that inspects how a
// streamed response ended needs both the report shape and the outcome names.
// `StreamDeadlineError` is what the client's stream errors with when a body
// deadline expires, and is exported so a host can recognise it.
export { StreamDeadlineError } from './internal/stream-watch.js';
export type { StreamOutcome, StreamReport } from './internal/stream-watch.js';
// `ProxyEvent.selection` references it, so consumers typing their `onProxy`
// need the shape even though the picker itself stays internal.
export type { Selection } from './internal/selection.js';
// `ProxyEvent.mirror` resolves to one of these, so a host watching what the
// copy made of itself needs the report shape even though the sender stays
// internal — same reason `StreamReport` is here.
export type { MirrorReport } from './internal/traffic-mirror.js';
// `ProxyEvent.inject` resolves to one of these, so a host that watches whether
// an injection actually landed needs the report shape and the anchor names.
export type { InjectAnchor, InjectReport } from './internal/body.js';
// `ProxyEvent.guardReason` references it, so a host watching which guard turned
// a request away needs the name list even though the guards stay internal.
export type { GuardReason } from './internal/guards.js';

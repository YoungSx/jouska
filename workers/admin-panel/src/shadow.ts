import { matchUrl, type Config } from 'jouska';

/**
 * Shadow-rule detection.
 *
 * Route order is significant — first match wins — so two routes that catch the
 * same traffic make the later one dead config: it parses, it publishes, it
 * never runs. The detector does not reimplement matching. It generates probe
 * requests from each route's own pattern and asks the library's `matchUrl`
 * whether an earlier route catches them, so the warning is provable by the
 * same code the proxy runs, not by a second opinion that could drift.
 */

export interface ShadowWarning {
  /** The later route that never receives the traffic. */
  readonly shadowedId: string;
  /** The earlier route that receives it instead. */
  readonly byId: string;
  /** A URL demonstrating the catch. */
  readonly probe: string;
}

/** Concrete hosts a host pattern matches. */
const hostProbes = (pattern: string | undefined): string[] => {
  if (pattern === undefined) {
    return [];
  }
  // `*.example.com` matches subdomains, never the apex, so probe a subdomain.
  return pattern.startsWith('*.') ? [`shadow-probe.${pattern.slice(2)}`] : [pattern];
};

/**
 * Hosts to probe route `index` with. When the route itself constrains the
 * host, its own pattern decides. When it does not — a hostless route intends
 * every host — probe with each earlier route's hosts, because that is where a
 * shadow can hide; a neutral canary covers the no-earlier-host case.
 */
const probeHosts = (config: Config, index: number): string[] => {
  const own = config.routes[index]?.match.host;
  if (own !== undefined) {
    return hostProbes(own);
  }
  const earlier = config.routes.slice(0, index).flatMap((route) => hostProbes(route.match.host));
  return earlier.length > 0 ? earlier : ['shadow-probe.invalid'];
};

/**
 * Paths to probe with. A route's prefix matches itself and anything under it,
 * so both are probed; a hostless path matches any path, so a canary goes with.
 */
const probePaths = (route: Config['routes'][number]): string[] => {
  const prefix = route.match.path;
  if (prefix === undefined) {
    return ['/', '/shadow-probe'];
  }
  return prefix === '/' ? ['/', '/shadow-probe'] : [prefix, `${prefix}/shadow-probe`];
};

/**
 * Detects later routes that an earlier route catches.
 *
 * A hostless route matches every method, so probing only `GET` would miss a
 * `POST`-only route in front of it; probing both covers the common asymmetry.
 */
export const shadowWarnings = (config: Config): ShadowWarning[] => {
  const warnings: ShadowWarning[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < config.routes.length; index++) {
    const route = config.routes[index]!;
    const shadowedId = route.id ?? `#${index}`;
    const hosts = probeHosts(config, index);
    const paths = probePaths(route);
    const methods = route.match.methods ?? ['GET', 'POST'];

    for (const host of hosts) {
      for (const path of paths) {
        for (const method of methods) {
          const probe = new URL(`https://${host}${path}`);
          const match = matchUrl(config, probe, method);
          if (match === undefined || match.index >= index) {
            continue;
          }
          const byId = config.routes[match.index]?.id ?? `#${match.index}`;
          const key = `${shadowedId}|${byId}`;
          if (!seen.has(key)) {
            seen.add(key);
            warnings.push({ shadowedId, byId, probe: probe.toString() });
          }
        }
      }
    }
  }
  return warnings;
};

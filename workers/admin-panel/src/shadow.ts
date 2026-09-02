import { matchUrl, type Config, type Route } from 'jouska';

/**
 * Shadow-rule detection.
 *
 * Route order is significant — first match wins — so two routes that catch the
 * same traffic make the later one dead config: it parses, it publishes, it
 * never runs. The detector does not reimplement matching. It generates probe
 * requests from each route's own pattern and asks the library's `matchUrl`
 * whether an earlier route catches them, so the warning is provable by the
 * same code the proxy runs, not by a second opinion that could drift.
 *
 * The pattern now includes `match.headers`, `match.query` and `match.cookies`:
 * a probe must *satisfy* the route's own conditions — carry the header the
 * route asks for, the query parameter, the cookie — or the traffic it
 * represents is not traffic the route would ever see, and any verdict built on
 * it is fiction. That is the difference between a warning and a false one, so
 * each probe is first shown to the route alone and only a route that matches
 * its own probe is eligible for shadowing.
 */

export interface ProbeHeader {
  readonly name: string;
  readonly value: string;
}

export interface ShadowWarning {
  /** The later route that never receives the traffic. */
  readonly shadowedId: string;
  /** The earlier route that receives it instead. */
  readonly byId: string;
  /** A URL demonstrating the catch. */
  readonly probe: string;
  /**
   * Headers the probe carries — a route's header conditions, plus a `cookie`
   * header when the route matches on cookies. Absent for a route that matches
   * on none of them, where the URL alone reproduces the catch.
   */
  readonly probeHeaders?: readonly ProbeHeader[];
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
 * The value one condition asks a probe to carry, or undefined when the probe
 * must *not* carry the name at all (`present: false`).
 *
 * `equals` takes the exact value — including the empty string, which is a
 * value. `prefix` appends a visible suffix rather than sending the bare
 * prefix, so the probe reads as synthetic if it ever shows up in an upstream's
 * logs. `present: true` needs existence only, and the same suffix stands in
 * for any value the visitor might send.
 */
const probeValue = (condition: {
  equals?: string | undefined;
  prefix?: string | undefined;
  present?: boolean | undefined;
}): string | undefined => {
  if (condition.present !== undefined) {
    return condition.present ? 'shadow-probe' : undefined;
  }
  if (condition.equals !== undefined) {
    return condition.equals;
  }
  return `${condition.prefix}shadow-probe`;
};

/**
 * Builds the header and query part of a probe that satisfies the route's own
 * conditions, or undefined when no single request can.
 *
 * The one unsatisfiable combination: a header condition naming `cookie`
 * competes with the cookie family for the same header, and except in trivial
 * cases no single value satisfies both. Rather than probe with a request the
 * route would reject, the route is skipped — a missed warning, never a false
 * one. Query conditions land in the URL; header conditions become headers;
 * cookie conditions are gathered into one `Cookie` header, the exact wire form
 * `readCookie` parses.
 */
const conditionProbe = (
  match: Route['match'],
): { search: string; headers: Headers } | undefined => {
  const search = new URLSearchParams();
  for (const condition of match.query ?? []) {
    const value = probeValue(condition);
    if (value !== undefined) {
      search.set(condition.name, value);
    }
  }

  const headers = new Headers();
  const headerConditions = match.headers ?? [];
  for (const condition of headerConditions) {
    const value = probeValue(condition);
    if (value !== undefined) {
      headers.set(condition.name, value);
    }
  }

  const cookieConditions = match.cookies ?? [];
  if (cookieConditions.length > 0) {
    if (headerConditions.some((condition) => condition.name === 'cookie')) {
      return undefined;
    }
    const pairs: string[] = [];
    for (const condition of cookieConditions) {
      const value = probeValue(condition);
      if (value !== undefined) {
        pairs.push(`${condition.name}=${value}`);
      }
    }
    if (pairs.length > 0) {
      headers.set('cookie', pairs.join('; '));
    }
  }

  return { search: search.toString(), headers };
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
    const probe = conditionProbe(route.match);
    if (probe === undefined) {
      continue;
    }
    const hosts = probeHosts(config, index);
    const paths = probePaths(route);
    const methods = route.match.methods ?? ['GET', 'POST'];
    // The route alone, to check each probe against its own route first: only
    // traffic the route would actually handle can be shadowed. Same library,
    // same `matchUrl` — the check proves the probe, not a second matcher.
    const alone: Config = { ...config, routes: [route] };
    const probeHeaders = [...probe.headers.entries()].map(([name, value]) => ({ name, value }));

    for (const host of hosts) {
      for (const path of paths) {
        for (const method of methods) {
          const url = new URL(`https://${host}${path}`);
          if (probe.search !== '') {
            url.search = probe.search;
          }
          if (matchUrl(alone, url, method, probe.headers)?.index !== 0) {
            continue;
          }
          const match = matchUrl(config, url, method, probe.headers);
          if (match === undefined || match.index >= index) {
            continue;
          }
          const byId = config.routes[match.index]?.id ?? `#${match.index}`;
          const key = `${shadowedId}|${byId}`;
          if (!seen.has(key)) {
            seen.add(key);
            warnings.push({
              shadowedId,
              byId,
              probe: url.toString(),
              ...(probeHeaders.length > 0 ? { probeHeaders } : {}),
            });
          }
        }
      }
    }
  }
  return warnings;
};

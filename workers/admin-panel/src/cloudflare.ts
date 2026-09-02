/**
 * Read-only Cloudflare API client for discovering where the proxy is reachable.
 *
 * The panel authors `match.host` values, and an operator writing one has to
 * know which hostnames actually arrive at the proxy Worker. That answer lives
 * in the Cloudflare account, not in this database, so it is fetched — with a
 * token that is deliberately read-only and never leaves this module.
 *
 * Three sources, in ascending order of cost:
 *
 * | Source         | Calls | Certainty                                  |
 * | -------------- | ----- | ------------------------------------------ |
 * | workers.dev    | 2     | exact hostname, when enabled               |
 * | Custom Domains | 1     | exact hostnames, filtered by script        |
 * | Zone routes    | 1 + N | route *patterns*, N = number of zones      |
 *
 * Zone routes cost one call per zone, and the free plan allows 50 subrequests
 * per invocation — so that source is bounded and reports when it truncated
 * rather than silently returning a partial answer.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Kind of evidence a hostname came from, which decides how it is presented. */
export type BindingKind = 'workers_dev' | 'custom_domain' | 'route';

export interface BoundHost {
  readonly kind: BindingKind;
  /**
   * For `workers_dev` and `custom_domain`, an exact hostname. For `route`, the
   * host portion of a route pattern, which may be a wildcard like `*.a.com`
   * and may therefore not be a hostname at all.
   */
  readonly host: string;
  /** The zone the binding lives in, when the source names one. */
  readonly zone?: string;
  /** Full route pattern, kept verbatim because the path part matters. */
  readonly pattern?: string;
}

/** A source that could not be read, named so the UI can say which. */
export interface SourceFailure {
  readonly source: BindingKind;
  readonly message: string;
}

export interface DiscoveryResult {
  readonly hosts: readonly BoundHost[];
  readonly failures: readonly SourceFailure[];
  /**
   * Zones that were not examined because the per-invocation zone budget ran
   * out. Present so "no routes found" is never confused with "did not look".
   */
  readonly skippedZones?: readonly string[];
}

export interface CloudflareCredentials {
  readonly accountId: string;
  readonly apiToken: string;
}

/**
 * Zones examined for routes in one discovery pass.
 *
 * The free plan's ceiling is 50 subrequests per invocation, and this worker
 * spends some of them on D1. Twelve zones plus the zone list plus the two
 * workers.dev calls and the domains call stays clear of it with room to spare;
 * an account with more zones gets a truthful "not all zones examined" instead
 * of an invocation that dies at the limit.
 */
const MAX_ZONES = 12;

/** Zones per page. The API's documented ceiling is 50. */
const ZONE_PAGE_SIZE = 50;

/**
 * Per-attempt deadline. A hung Cloudflare API call must not consume the
 * panel's whole request budget; a partial answer with a named failure is more
 * useful than a timeout with none.
 */
const REQUEST_TIMEOUT_MS = 5_000;

interface ApiEnvelope<T> {
  readonly success?: boolean;
  readonly result?: T;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a string field, returning undefined for anything else.
 *
 * The API's shapes are documented but this is still parsing someone else's
 * JSON: a field that arrives as null must not become the string "null".
 */
const stringField = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * Joins the API's error array into one message.
 *
 * Cloudflare answers 200 with `success: false` for some failures, so the
 * status code alone does not decide; the envelope is what is checked.
 */
const envelopeError = (envelope: ApiEnvelope<unknown>, status: number): string => {
  const messages = (envelope.errors ?? [])
    .map((entry) => entry.message)
    .filter((message): message is string => typeof message === 'string' && message !== '');
  if (messages.length > 0) {
    return messages.join('; ');
  }
  return `HTTP ${status}`;
};

/**
 * One authenticated GET against the Cloudflare API.
 *
 * Throws on anything that is not a successful envelope, so each call site
 * decides whether that failure sinks the whole answer or just one source.
 */
const apiGet = async <T>(
  credentials: CloudflareCredentials,
  path: string,
  fetchImpl: typeof fetch,
): Promise<T> => {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    headers: {
      // The token is used here and nowhere else: it is never logged, never
      // returned to the client, and never written to D1 or KV.
      authorization: `Bearer ${credentials.apiToken}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // A non-JSON body means something other than the API answered — a proxy
    // error page, most likely. The status is the only signal worth reporting.
    throw new Error(`HTTP ${response.status} (response was not JSON)`);
  }
  if (!response.ok || envelope.success === false || envelope.result === undefined) {
    throw new Error(envelopeError(envelope, response.status));
  }
  return envelope.result;
};

/**
 * Splits a route pattern into its host and the rest.
 *
 * Patterns look like `example.com/*`, `*.example.com/api/*` or bare
 * `example.com`. Only the host part is comparable to `match.host`, and it can
 * be a wildcard — which is why the caller keeps the whole pattern too.
 */
const patternHost = (pattern: string): string | undefined => {
  const slash = pattern.indexOf('/');
  const host = slash === -1 ? pattern : pattern.slice(0, slash);
  return host === '' ? undefined : host.toLowerCase();
};

/**
 * The script's workers.dev hostname, when it has one.
 *
 * Two calls, because the account owns the subdomain and the script owns the
 * switch: `<script>.<subdomain>.workers.dev` only resolves when the script's
 * own `enabled` is true, so reading one without the other would invent a
 * hostname that answers nothing.
 */
const discoverWorkersDev = async (
  credentials: CloudflareCredentials,
  scriptName: string,
  fetchImpl: typeof fetch,
): Promise<BoundHost[]> => {
  const script = await apiGet<{ enabled?: unknown }>(
    credentials,
    `/accounts/${encodeURIComponent(credentials.accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    fetchImpl,
  );
  if (!isRecord(script) || script['enabled'] !== true) {
    return [];
  }
  const account = await apiGet<{ subdomain?: unknown }>(
    credentials,
    `/accounts/${encodeURIComponent(credentials.accountId)}/workers/subdomain`,
    fetchImpl,
  );
  const subdomain = isRecord(account) ? stringField(account, 'subdomain') : undefined;
  if (subdomain === undefined) {
    return [];
  }
  return [{ kind: 'workers_dev', host: `${scriptName}.${subdomain}.workers.dev`.toLowerCase() }];
};

/**
 * Custom Domains attached to the script.
 *
 * Account-level and filterable by service, so this is one call regardless of
 * how many zones the account has — the cheapest exact answer available.
 */
const discoverCustomDomains = async (
  credentials: CloudflareCredentials,
  scriptName: string,
  fetchImpl: typeof fetch,
): Promise<BoundHost[]> => {
  const result = await apiGet<unknown>(
    credentials,
    `/accounts/${encodeURIComponent(credentials.accountId)}/workers/domains?service=${encodeURIComponent(scriptName)}`,
    fetchImpl,
  );
  if (!Array.isArray(result)) {
    return [];
  }
  const hosts: BoundHost[] = [];
  for (const entry of result) {
    if (!isRecord(entry)) {
      continue;
    }
    const hostname = stringField(entry, 'hostname');
    if (hostname === undefined) {
      continue;
    }
    // The filter is server-side, but a mismatched `service` would misattribute
    // another Worker's domain to this one — so it is checked here too.
    const service = stringField(entry, 'service');
    if (service !== undefined && service !== scriptName) {
      continue;
    }
    const zone = stringField(entry, 'zone_name');
    hosts.push({
      kind: 'custom_domain',
      host: hostname.toLowerCase(),
      ...(zone === undefined ? {} : { zone }),
    });
  }
  return hosts;
};

/** One page of zones, reduced to the fields routes discovery needs. */
const listZones = async (
  credentials: CloudflareCredentials,
  fetchImpl: typeof fetch,
): Promise<{ id: string; name: string }[]> => {
  const result = await apiGet<unknown>(
    credentials,
    `/zones?account.id=${encodeURIComponent(credentials.accountId)}&per_page=${ZONE_PAGE_SIZE}`,
    fetchImpl,
  );
  if (!Array.isArray(result)) {
    return [];
  }
  const zones: { id: string; name: string }[] = [];
  for (const entry of result) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = stringField(entry, 'id');
    const name = stringField(entry, 'name');
    if (id !== undefined && name !== undefined) {
      zones.push({ id, name });
    }
  }
  return zones;
};

/**
 * Route patterns pointing at the script, across the account's zones.
 *
 * Routes are zone-scoped with no account-wide listing, so this is 1 + N calls
 * and the only source that can be truncated. Zones beyond the budget are
 * reported by name rather than dropped.
 */
const discoverRoutes = async (
  credentials: CloudflareCredentials,
  scriptName: string,
  fetchImpl: typeof fetch,
): Promise<{ hosts: BoundHost[]; skippedZones: string[] }> => {
  const zones = await listZones(credentials, fetchImpl);
  const examined = zones.slice(0, MAX_ZONES);
  const skippedZones = zones.slice(MAX_ZONES).map((zone) => zone.name);
  const hosts: BoundHost[] = [];
  // Sequential on purpose: the runtime allows six connections waiting for
  // headers, and a fan-out across a dozen zones would queue against that
  // ceiling while also risking the API's own rate limit.
  for (const zone of examined) {
    let result: unknown;
    try {
      result = await apiGet<unknown>(
        credentials,
        `/zones/${encodeURIComponent(zone.id)}/workers/routes`,
        fetchImpl,
      );
    } catch {
      // A zone the token cannot read is expected when the token is scoped to
      // some zones; treat it as "nothing here" rather than failing the source,
      // and let the zone still be listed as skipped so the gap is visible.
      skippedZones.push(zone.name);
      continue;
    }
    if (!Array.isArray(result)) {
      continue;
    }
    for (const entry of result) {
      if (!isRecord(entry)) {
        continue;
      }
      if (stringField(entry, 'script') !== scriptName) {
        continue;
      }
      const pattern = stringField(entry, 'pattern');
      if (pattern === undefined) {
        continue;
      }
      const host = patternHost(pattern);
      if (host === undefined) {
        continue;
      }
      hosts.push({ kind: 'route', host, pattern, zone: zone.name });
    }
  }
  return { hosts, skippedZones };
};

/**
 * De-duplicates by kind and host, keeping the first occurrence.
 *
 * A hostname can legitimately appear as both a Custom Domain and a route
 * pattern; collapsing across kinds would hide that, so the key includes the
 * kind and the pattern.
 */
const dedupe = (hosts: readonly BoundHost[]): BoundHost[] => {
  const seen = new Set<string>();
  const unique: BoundHost[] = [];
  for (const entry of hosts) {
    // Escaped, not a literal NUL byte — see the note in api/domains.ts.
    const key = `${entry.kind}\u0000${entry.host}\u0000${entry.pattern ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
};

/**
 * Every hostname the named script is reachable on, as far as the token can see.
 *
 * Each source is independently fallible: a token with `Workers Scripts Read`
 * but no `Zone Read` still answers the workers.dev and Custom Domain
 * questions, and says so about the third. A source that fails is named in
 * `failures` rather than throwing, because a partial answer is the useful one.
 */
export const discoverBoundHosts = async (
  credentials: CloudflareCredentials,
  scriptName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult> => {
  const hosts: BoundHost[] = [];
  const failures: SourceFailure[] = [];
  let skippedZones: string[] = [];

  // Sequential, not parallel: three concurrent sources plus the per-zone loop
  // would contend for the six-connection ceiling, and the ordering here also
  // makes the cheapest, most certain sources answer first.
  const sources: readonly {
    kind: BindingKind;
    run: () => Promise<{ hosts: BoundHost[]; skippedZones?: string[] }>;
  }[] = [
    {
      kind: 'workers_dev',
      run: async () => ({ hosts: await discoverWorkersDev(credentials, scriptName, fetchImpl) }),
    },
    {
      kind: 'custom_domain',
      run: async () => ({ hosts: await discoverCustomDomains(credentials, scriptName, fetchImpl) }),
    },
    { kind: 'route', run: () => discoverRoutes(credentials, scriptName, fetchImpl) },
  ];

  for (const source of sources) {
    try {
      const outcome = await source.run();
      hosts.push(...outcome.hosts);
      if (outcome.skippedZones !== undefined) {
        skippedZones = outcome.skippedZones;
      }
    } catch (error) {
      failures.push({
        source: source.kind,
        // The message is operator-facing and comes from Cloudflare's own error
        // array; the token is not part of any of these paths.
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  return {
    hosts: dedupe(hosts),
    failures,
    ...(skippedZones.length > 0 ? { skippedZones } : {}),
  };
};

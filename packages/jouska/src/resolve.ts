import { configSchema, type Config, type ConfigInput } from './config.js';

/**
 * Config precedence.
 *
 * A route table can come from two places: written in code, or stored remotely
 * (KV, D1, an admin panel). Code always wins. That is deliberate — the
 * code-defined table is the escape hatch: it lives in git, is reviewable and
 * revertable, and keeps working when the remote store is unreachable or has
 * been filled with something broken. Runtime config offers none of that.
 */

export type MergeStrategy = 'replace' | 'byId';

export interface ResolveOptions {
  /** Written in code. Highest precedence. */
  code?: ConfigInput;
  /**
   * Fetched at runtime. Untrusted in the sense that it is validated the same
   * way as code config, and loses every conflict.
   */
  remote?: unknown;
  /**
   * `replace` (default): a code table replaces the remote one wholesale, which
   * is the predictable choice. `byId`: routes merge by `id`, so a panel can add
   * routes alongside code-defined ones.
   */
  merge?: MergeStrategy;
  /**
   * Called when remote config fails validation. Defaults to swallowing the
   * error and falling back to code, so a corrupt remote table cannot take the
   * proxy down. Pass a handler to log it.
   */
  onRemoteError?: (error: unknown) => void;
}

/** Discards remote config that does not validate; the caller is told via `onRemoteError`. */
const parseRemote = (
  remote: unknown,
  onRemoteError: ((error: unknown) => void) | undefined,
): Config | undefined => {
  if (remote === undefined || remote === null) {
    return undefined;
  }
  const result = configSchema.safeParse(remote);
  if (result.success) {
    return result.data;
  }
  onRemoteError?.(result.error);
  return undefined;
};

/**
 * Merges by `id`: a code route replaces the remote route sharing its id, and
 * code routes come first so they also win route-matching order. Remote routes
 * with no code counterpart are kept, appended after.
 */
const mergeById = (code: Config, remote: Config): Config => {
  const codeIds = new Set(code.routes.map((r) => r.id).filter((id) => id !== undefined));
  const surviving = remote.routes.filter((r) => r.id === undefined || !codeIds.has(r.id));
  return {
    version: code.version,
    // Provenance describes a runtime write, which only the remote document has:
    // code changes are tracked by git, not by these fields. Keeping the remote
    // meta lets an operator still see who last edited the stored half.
    ...(remote.meta !== undefined ? { meta: remote.meta } : {}),
    routes: [...code.routes, ...surviving] as Config['routes'],
  };
};

/**
 * Resolves the effective config. Throws `z.ZodError` if code config is invalid
 * — that is a programming error and should fail loudly — but tolerates invalid
 * remote config by falling back to code.
 *
 * Throws when neither source yields a usable table, since a proxy with no
 * routes cannot serve anything.
 */
export const resolveConfig = ({
  code,
  remote,
  merge = 'replace',
  onRemoteError,
}: ResolveOptions): Config => {
  // Code config is parsed unguarded: a mistake here must surface immediately.
  const fromCode = code === undefined ? undefined : configSchema.parse(code);
  const fromRemote = parseRemote(remote, onRemoteError);

  if (fromCode === undefined) {
    if (fromRemote === undefined) {
      throw new Error(
        'resolveConfig: no usable config; provide code config, valid remote config, or both',
      );
    }
    return fromRemote;
  }
  if (fromRemote === undefined) {
    return fromCode;
  }
  return merge === 'byId' ? mergeById(fromCode, fromRemote) : fromCode;
};

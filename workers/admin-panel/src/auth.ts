/**
 * Session management and the auth middleware.
 *
 * Tokens are 32 random bytes, base64url'd into the cookie; D1 stores only
 * their SHA-256. Sliding expiry with a hard cap: activity refreshes the
 * deadline up to SESSION_MAX_AGE_MS from creation, so an indefinitely-active
 * session still dies.
 */
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, SESSION_TTL_MS } from './iterations.js';

export interface SessionUser {
  readonly userId: number;
  readonly subject: string;
  readonly role: 'admin' | 'viewer';
}

/** The subset of D1Database this module needs, so tests can pass a stub. */
export interface SessionStore {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
    };
  };
}

const encoder = new TextEncoder();

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const createSession = async (
  store: SessionStore,
  user: { id: number },
): Promise<{ token: string; expiresAt: number }> => {
  const token = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const now = nowSeconds();
  const expiresAt = now + Math.floor(SESSION_TTL_MS / 1000);
  await store
    .prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .bind(await sha256(token), user.id, now, expiresAt)
    .run();
  return { token, expiresAt };
};

/** Refreshes expiry if the session is past half its TTL and under the hard cap. */
const maybeRefresh = async (
  store: SessionStore,
  tokenHash: string,
  createdAt: number,
): Promise<void> => {
  const now = nowSeconds();
  const ageMs = (now - createdAt) * 1000;
  if (ageMs > SESSION_TTL_MS / 2 && now - createdAt < Math.floor(SESSION_MAX_AGE_MS / 1000)) {
    await store
      .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .bind(now + Math.floor(SESSION_TTL_MS / 1000), tokenHash)
      .run();
  }
};

/**
 * Resolves the request's cookie to a user, or undefined.
 *
 * Returns the row even when disabled — the caller decides between 401 and 403
 * and can audit the attempt.
 */
export const resolveSession = async (
  store: SessionStore,
  cookie: string | undefined,
): Promise<SessionUser | undefined> => {
  if (cookie === undefined) {
    return undefined;
  }
  const match = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) {
    return undefined;
  }
  const token = match.slice(SESSION_COOKIE.length + 1);
  if (token === '') {
    return undefined;
  }
  const tokenHash = await sha256(token);
  const row = await store
    .prepare(
      `SELECT s.token_hash, s.created_at, s.expires_at, u.id AS user_id, u.subject, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{
      token_hash: string;
      created_at: number;
      expires_at: number;
      user_id: number;
      subject: string;
      role: string;
      disabled: number;
    }>();
  if (row === null) {
    return undefined;
  }
  if (row.expires_at <= nowSeconds() || row.disabled) {
    return undefined;
  }
  await maybeRefresh(store, tokenHash, row.created_at);
  return {
    userId: row.user_id,
    subject: row.subject,
    role: row.role === 'viewer' ? 'viewer' : 'admin',
  };
};

export const destroySession = async (
  store: SessionStore,
  cookie: string | undefined,
): Promise<void> => {
  if (cookie === undefined) {
    return;
  }
  const match = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) {
    return;
  }
  await store
    .prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(await sha256(match.slice(SESSION_COOKIE.length + 1)))
    .run();
};

export const sessionCookieHeader = (token: string, expiresAt: number, secure: boolean): string =>
  `${SESSION_COOKIE}=${token}; Path=/; Expires=${new Date(expiresAt * 1000).toUTCString()}; HttpOnly; SameSite=Strict${
    secure ? '; Secure' : ''
  }`;

export const clearCookieHeader = (): string =>
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;

/** Cookie name for callers that need to read it back. */
export { SESSION_COOKIE };

## 2026-09-08 - Overly Permissive CORS Default
**Vulnerability:** CORS configuration reflected any `Origin` header when no origins were explicitly configured, even with `credentials: true`.
**Learning:** The fallback `((origin) => origin)` in `hono/cors` configuration was intentionally added to make credentialed requests work by default, bypassing browser security checks against `*` with credentials.
**Prevention:** Avoid dynamic origin reflection without validation. Default to `'*'` and force explicit configuration of allowed origins if credentials are required.

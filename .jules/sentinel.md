## 2026-10-13 - Missing Security Headers in Admin Panel

**Vulnerability:** The Admin Panel API (`workers/admin-panel/src/index.ts`) was missing baseline security headers (CSP, X-Frame-Options, X-Content-Type-Options, etc.).
**Learning:** Hono applications do not have security headers applied by default. This must be explicitly added as middleware.
**Prevention:** When creating or refactoring Hono applications in this repository, always import `secureHeaders` from `hono/secure-headers` and apply `app.use('*', secureHeaders())` globally early in the initialization process for baseline web vulnerability protection (unless it's the reverse proxy).

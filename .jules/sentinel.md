## 2025-02-14 - Baseline Web Vulnerability Protection for Hono Admin Panel API

**Vulnerability:** Missing baseline web security headers (XSS, Clickjacking, MIME-sniffing protection) in the Admin Panel API.
**Learning:** The Admin Panel API (`workers/admin-panel/src/api`), architected with Hono, needs `secureHeaders()` applied globally for baseline web vulnerability protection. However, do not apply this to the reverse-proxy worker because it must remain transparent.
**Prevention:** When creating or refactoring Hono applications in this repository (such as the admin-panel), import `secureHeaders` from `hono/secure-headers` and apply `app.use('*', secureHeaders())` globally early in the initialization process.

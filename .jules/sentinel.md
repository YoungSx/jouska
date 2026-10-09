## 2025-02-28 - Missing SecureHeaders in Hono Applications

**Vulnerability:** The Admin Panel API (`workers/admin-panel/src/index.ts`) was missing the global `secureHeaders()` middleware, leaving it vulnerable to common web vulnerabilities like MIME-sniffing, XSS, and Clickjacking despite being built with Hono.
**Learning:** While the reverse-proxy worker shouldn't use `secureHeaders()` because it must remain transparent, Hono API applications (like the admin-panel) must explicitly register `app.use('*', secureHeaders())` early in initialization to get baseline web vulnerability protection.
**Prevention:** Always apply `secureHeaders()` globally to new or refactored Hono applications in this repository (except the reverse proxy) by importing from `hono/secure-headers`.

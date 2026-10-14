## 2024-10-14 - Admin Panel Missing Security Headers

**Vulnerability:** Missing baseline web vulnerability protection (XSS, Clickjacking, MIME-sniffing) on Admin Panel API.
**Learning:** The Admin Panel API was missing Hono's `secureHeaders` middleware, leaving it vulnerable to common web attacks.
**Prevention:** Ensure all Hono applications (except the reverse-proxy worker) have `secureHeaders()` applied globally early in the initialization process.

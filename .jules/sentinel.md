## 2024-10-11 - Missing secureHeaders in Admin Panel Hono App

**Vulnerability:** The Admin Panel Hono API was missing baseline web vulnerability protection (XSS, Clickjacking, MIME-sniffing) because `secureHeaders()` was not applied globally.
**Learning:** Hono applications do not have these security headers by default. They need to be explicitly added using the `secureHeaders` middleware to ensure applications are protected against common web vulnerabilities. However, reverse proxy workers should not have these headers applied globally.
**Prevention:** When creating or refactoring Hono applications in this repository, always apply `app.use('*', secureHeaders())` globally early in the initialization process for baseline web vulnerability protection, except for reverse-proxy workers.

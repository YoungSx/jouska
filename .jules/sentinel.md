## 2025-02-18 - Admin Panel Baseline Web Protection

**Vulnerability:** Missing secure headers on admin panel responses (X-Frame-Options, X-XSS-Protection, etc.).
**Learning:** The admin panel is a Hono application and requires `secureHeaders()` globally. However, this must NOT be applied to the reverse-proxy worker because forcing strict headers on proxied traffic can cause breaking changes.
**Prevention:** Apply `app.use('*', secureHeaders())` early in the initialization of Hono apps that serve their own content (like admin-panel), but avoid it on transparent proxies.

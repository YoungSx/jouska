## 2024-10-05 - Add secureHeaders to Admin API

**Vulnerability:** The Admin Panel API (`workers/admin-panel/src/index.ts`) missed a global application of `hono/secure-headers`, leaving a potential gap for baseline web vulnerabilities (like MIME-sniffing, XSS, and Clickjacking).
**Learning:** While the API relies exclusively on Cloudflare Access for authentication and custom `requireSameOrigin` for CSRF, baseline headers are still required to strengthen the application's overall defense-in-depth posture.
**Prevention:** Always ensure `app.use('*', secureHeaders())` is applied early in the Hono application initialization before defining explicit routes, in all new services or refactors.

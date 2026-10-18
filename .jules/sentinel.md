## 2024-06-03 - Hono Secure Headers Missing in Admin Panel

**Vulnerability:** The Admin Panel API was missing baseline web vulnerability protections (like CSP, X-Frame-Options, X-XSS-Protection) because the Hono `secureHeaders()` middleware was not applied.
**Learning:** While CSRF and auth were addressed with custom middlewares (`requireSameOrigin` and Cloudflare Access), the standard defense-in-depth headers were omitted during initialization of the `app` instance.
**Prevention:** Apply `app.use('*', secureHeaders())` globally at the top level of the Admin Panel application router to establish a secure baseline for all endpoints.

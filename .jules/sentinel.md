## 2024-05-24 - Missing Baseline Security Headers in Hono Admin Apps
**Vulnerability:** Admin Panel API was missing baseline web security headers (X-XSS-Protection, X-Frame-Options, X-Content-Type-Options, etc.), making it vulnerable to XSS, Clickjacking, and MIME-sniffing.
**Learning:** Hono applications do not have these headers enabled by default. While CSRF was protected via custom middleware, the lack of `secureHeaders` left basic web vulnerabilities open.
**Prevention:** Always apply `app.use('*', secureHeaders())` globally early in the initialization of Hono-based admin applications (except the reverse proxy) to enforce baseline web security.

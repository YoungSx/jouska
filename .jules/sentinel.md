## 2024-10-07 - Baseline Web Vulnerability Protection for Hono Apps

**Vulnerability:** Missing security headers in the admin panel application exposed the API to baseline web vulnerabilities (XSS, Clickjacking, MIME-sniffing).
**Learning:** The admin panel (and future Hono applications, except the reverse-proxy) must have baseline security headers enabled by default to provide defense-in-depth against common web vulnerabilities.
**Prevention:** Apply `app.use('*', secureHeaders())` globally early in the Hono initialization process (before defining routes). Ensure NOT to apply this to the reverse-proxy worker to avoid breaking downstream sites.

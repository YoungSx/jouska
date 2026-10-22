
## 2024-10-22 - [Add Secure Headers to Admin Panel]
**Vulnerability:** Missing security headers on the admin-panel API.
**Learning:** While the application uses a `requireSameOrigin` middleware for CSRF protection and Cloudflare Access for authentication, it was missing baseline web vulnerability protection headers (like Content Security Policy, X-Frame-Options, X-Content-Type-Options).
**Prevention:** Apply `secureHeaders` middleware from the `hono/secure-headers` package globally early in the initialization of Hono applications to establish defense in depth against XSS, clickjacking, and MIME-sniffing.

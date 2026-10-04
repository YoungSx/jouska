## 2025-05-27 - Added secure security headers

**Vulnerability:** Missing security headers on Admin API Worker.
**Learning:** `hono/secure-headers` adds default security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-XSS-Protection: 1; mode=block`, `Strict-Transport-Security: max-age=15552000; includeSubDomains`, and more) which protect the panel against XSS, clickjacking, MIME-type sniffing, and enforce HTTPS. This needs to be explicitly applied.
**Prevention:** Apply `secureHeaders` middleware from hono in `index.ts`.

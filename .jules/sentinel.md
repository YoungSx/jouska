## 2025-02-18 - [Missing Security Headers in Admin Panel]
**Vulnerability:** The admin panel API responses lacked essential security headers such as `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, and `Referrer-Policy`.
**Learning:** Security headers are not automatically added by Hono in this codebase and must be manually configured via middleware.
**Prevention:** Implement a global `securityHeaders` middleware early in the `app` instance pipeline for all Hono-based applications in the repository to ensure defense-in-depth against framing, MIME-sniffing, and insecure transport.

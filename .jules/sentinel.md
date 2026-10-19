## 2024-05-18 - Admin Panel Security Headers

**Vulnerability:** Missing baseline security headers in the Admin Panel API.
**Learning:** While the Admin Panel relies on Cloudflare Access for authentication and a custom `requireSameOrigin` for CSRF, it lacked standard HTTP security headers to protect against common web vulnerabilities like XSS, Clickjacking, and MIME-sniffing.
**Prevention:** Apply `secureHeaders()` globally to Hono applications where applicable to provide a secure baseline, except for reverse proxies where transparency is required.


## 2024-05-27 - [Baseline Security Headers]
**Vulnerability:** Missing standard HTTP security headers (X-Frame-Options, X-Content-Type-Options, etc.) on the admin panel application.
**Learning:** The admin panel uses Hono, but lacked the global application of Hono's `secureHeaders` middleware, leaving it susceptible to basic web vulnerabilities like clickjacking and MIME-sniffing.
**Prevention:** Always apply `app.use('*', secureHeaders())` early in the setup of any Hono-based application handling sensitive interfaces to ensure baseline web vulnerability protection.

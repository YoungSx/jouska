## 2024-02-14 - [Adding Security Headers]
**Vulnerability:** Missing security headers on the admin-panel and adding them incorrectly to the reverse-proxy.
**Learning:** Adding security headers like X-Frame-Options to a reverse-proxy breaks proxied websites and causes unexpected errors for end users. They should only be added to internal APIs or applications where the structure is known.
**Prevention:** Avoid blindly adding `secureHeaders` middleware to all Hono instances, especially proxy/gateway services, as it alters the transparency of the proxy.

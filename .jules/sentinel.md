## 2024-03-XX - [CORS Reflection Vulnerability]

**Vulnerability:** The CORS middleware reflected any requested `Origin` back in the `Access-Control-Allow-Origin` header while allowing `credentials: true`. This was done intentionally to bypass the browser restriction that forbids `*` with credentials.
**Learning:** Reflecting any origin with `credentials: true` completely defeats the Same-Origin Policy for credentialed requests, allowing any malicious site to make authenticated requests.
**Prevention:** Default to `*` for empty origins, and explicitly forbid configuring `credentials: true` without a specific list of allowed origins.

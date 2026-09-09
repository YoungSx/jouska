## 2023-11-20 - URL String Optimization

**Learning:** Cloudflare Workers CPU time limit is extremely tight (10ms). Repeated `String.prototype.split()` allocations inside hot-path routing functions (like `hostMatches` and URL normalizations) consume significant memory and CPU.
**Action:** Replace arrays with explicit string checking methods (`.slice`, `.startsWith`, `.endsWith`, `.includes`, `.search`) on hot paths to eliminate array allocation completely while maintaining functionality.

## 2024-09-07 - Cached expensive URL normalization in router loop

**Learning:** URL normalization (`pathCandidates`) was being re-evaluated for every single route in the routing table loop (`config.routes`). This function decodes URI strings and loops up to 8 times to handle edge cases like `%2f` and dot segments. This led to O(N) evaluations, heavily degrading performance for configurations with many routes.

**Action:** Caching the result of `pathCandidates` inside the routing loop prevents it from being recalculated. The cache is initialized lazily so that configurations where the host doesn't match don't incur the cost at all. I also cached the request method uppercase string to save those recalculations too.

## 2026-09-07 - Cached expensive URL normalization in router loop

**Learning:** URL normalization (`pathCandidates`) was being re-evaluated for every single route in the routing table loop (`config.routes`). This function decodes URI strings and loops up to 8 times to handle edge cases like `%2f` and dot segments. This led to O(N) evaluations, heavily degrading performance for configurations with many routes.

**Action:** Caching the result of `pathCandidates` inside the routing loop prevents it from being recalculated. The cache is initialized lazily so that configurations where the host doesn't match don't incur the cost at all. I also cached the request method uppercase string to save those recalculations too.

## 2026-09-10 - Do not assume unvalidated state in `config.routes` matching

**Learning:** Attempting to optimize HTTP method matching by substituting case-sensitive `includes()` for case-insensitive `toUpperCase()` inside `router.ts` `matchUrl` is not considered safe because it relies on the pre-condition that the config parsing/validation logic (Zod) has already uppercased `route.match.methods`. Although true for validated configs, removing case-insensitivity from the edge matcher risks authentication/routing bypasses if raw config data is somehow injected. This micro-optimization breaks the principle of defensive coding at the matcher boundary.

**Action:** Avoid micro-optimizations that alter the strictness of core matchers (like case-insensitivity on HTTP methods). Look for broader systemic optimizations like unnecessary O(N) recalculations on React re-renders instead.

## 2024-05-18 - Memoize RevisionDiff computations

**Learning:** Derived state computations like large array sorts (e.g. `blocksOf` which iterates, buckets, and sorts `entries` with O(N log N) complexity) in heavily used components such as `RevisionDiff` can become performance bottlenecks if not memoized, particularly when the components handle large data structures returned from APIs that are immutable until new data is fetched.
**Action:** Use `React.useMemo` to memoize expensive derived state, especially when it involves O(N) array traversals or O(N log N) sorting on data that is provided via props and rarely changes (like fetched API lists/diffs) to prevent unnecessary recomputations on unrelated component re-renders.

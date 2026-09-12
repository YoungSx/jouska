## 2026-09-12 - Cache config normalization result to avoid recalculating in hot loop

**Learning:** In a hot path, even simple built-in string methods (e.g. `String.prototype.toUpperCase`) can become a bottleneck when called on every request iteration. Zod schemas perform normalization when they parse, so config objects are already uniform by the time they reach request-handling code.
**Action:** Rely on schema parsing validation and transformation for data normalization instead of constantly repeating the operation during request routing or processing. It's much cheaper to process it once in config initialization.

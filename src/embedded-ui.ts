/**
 * UI files embedded into a `bun build --compile` executable: URL path (e.g. `/index.html`) → path of the
 * embedded file (readable with `Bun.file`). Filled by the entry point `scripts/compile.ts` generates before
 * `main.ts` runs; empty when running from source, where the UI is served from `public/` on disk.
 */
export const embeddedUi = new Map<string, string>();

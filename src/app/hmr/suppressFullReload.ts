/**
 * Soft-HMR-only guard: keep in-place module swaps, skip Vite full page reloads.
 * Set SF_FULL_RELOAD=1 to restore automatic structural reloads.
 *
 * Vite 6 only reloads when payload.path is missing or matches the current HTML
 * page; forcing a non-matching .html path skips pageReload() after listeners run.
 */
export const suppressesFullReload =
  import.meta.env.DEV && import.meta.env.SF_FULL_RELOAD !== true;

if (import.meta.hot && suppressesFullReload) {
  import.meta.hot.on("vite:beforeFullReload", (payload) => {
    const path = typeof payload === "object" && payload && "path" in payload ? payload.path : undefined;
    (payload as { path?: string }).path = "(sf-skip-full-reload).html";
    console.info("[hmr] full reload suppressed — refresh manually when ready", path ?? payload);
  });
}

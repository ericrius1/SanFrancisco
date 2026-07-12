import { TUNABLES_UPDATED_EVENT, tunables } from "../../core/persist";

const SPEC = {
  enabled: { v: true, label: "enabled" },
  brightness: { v: 1, min: 0, max: 2.5, step: 0.05, label: "light strength" },
  drift: { v: 1, min: 0, max: 2, step: 0.05, label: "flight speed" },
  pulse: { v: 0.14, min: 0, max: 0.35, step: 0.005, label: "flicker depth" },
  glowSize: { v: 1, min: 0.5, max: 1.8, step: 0.05, label: "glow size" }
};

/** Kept outside fireflies.ts so visual HMR has only one path back to main. */
export const BUSKER_FIREFLY_TUNING = tunables("busker.fireflies", SPEC);

if (import.meta.hot) {
  // A source-default edit is safe in place: tunables() reuses the values object
  // already referenced by gameplay and Tweakpane. Range/label/key edits need a
  // pane rebuild, so propagate those structural changes to the full-reload path.
  const paneSchema = JSON.stringify(
    Object.entries(SPEC).map(([key, entry]) => {
      const { v: _defaultValue, ...binding } = entry;
      return [key, binding];
    })
  );
  const previousPaneSchema = import.meta.hot.data.paneSchema as string | undefined;
  import.meta.hot.data.paneSchema = paneSchema;
  import.meta.hot.accept();
  if (previousPaneSchema && previousPaneSchema !== paneSchema) {
    import.meta.hot.invalidate("busker tuning controls changed");
  } else if (previousPaneSchema) {
    window.dispatchEvent(new Event(TUNABLES_UPDATED_EVENT));
  }
}

// One lazy customizer-selector controller, shared by every mode's atelier.
// Extracted from main.ts per docs/MAIN_DECOMPOSITION.md step 3.
//
// Previously the avatar/board/scooter selectors were static imports constructed
// at boot (their whole UI chunk in the entry graph); car/surfboard were already
// hand-rolled dynamic imports. This unifies all five behind one mechanic: at
// boot only a tiny placeholder launcher button exists (no selector chunk in the
// waterfall). The selector's module dynamic-imports on FIRST OPEN, an in-flight
// guard makes a double-press idempotent, and the launcher is retired once the
// real selector (which mounts its own toggle) is live.
//
// Config state stays boot-resident in main.ts; only the UI/preview module is
// lazy. `load()` reads the CURRENT config at construction time, and the setter
// call sites optional-chain through `get()` so a pre-load `setConfig`/`setName`
// is a safe no-op (the value is picked up when the panel is finally built).

/** The two-method surface every selector panel exposes to the hub. */
export interface LazyPanel {
  setOpen(open: boolean): void;
  setVisible(visible: boolean): void;
}

export interface LazySelectorSpec<T extends LazyPanel> {
  /** Stable id for debugging / warnings. */
  id: string;
  /** Classes for the placeholder launcher wrapper div (mirror the real toggle
   * so CSS + probe selectors keep matching, e.g. "avatar-ui car-ui
   * car-launcher-ui"). */
  launcherClass: string;
  /** Classes for the placeholder launcher button (e.g. "avatar-toggle
   * car-toggle"). */
  toggleClass: string;
  /** Customizer icon path under public/ui/customizer-icons/. */
  icon: string;
  title: string;
  ariaLabel: string;
  /** True while this selector's mode owns the single top-right customizer slot. */
  active: () => boolean;
  /** Dynamic-import the selector module and construct it with the current
   * config state. Called at most once (subsequent opens reuse the instance). */
  load: () => Promise<T>;
  /** Invoked on the launcher-button click, before the open request (e.g. release
   * pointer lock). Not invoked for programmatic `ensure(true)`. */
  onLauncherClick?: () => void;
  /** Load-failure handler; defaults to a console.warn. */
  onError?: (error: unknown) => void;
}

export interface LazySelector<T extends LazyPanel> {
  /** Open intent. `open=true` refuses unless `active()`; loads-then-opens with a
   * single in-flight guard so a double-press never double-constructs. */
  ensure(open?: boolean): void;
  /** Slot visibility for the current mode: shows the real panel if built, else
   * the placeholder launcher. Also cancels a pending open when the slot leaves. */
  syncVisible(show: boolean): void;
  /** The constructed panel, or null until first open. */
  get(): T | null;
}

/**
 * Build a lazy selector: mounts a placeholder launcher into `host`, and
 * dynamic-imports the real panel on first open.
 */
export function createLazySelector<T extends LazyPanel>(
  host: HTMLElement,
  spec: LazySelectorSpec<T>
): LazySelector<T> {
  let selector: T | null = null;
  let loading: Promise<void> | null = null;
  let openAfterLoad = false;

  const launcher = document.createElement("div");
  launcher.className = spec.launcherClass;
  const button = document.createElement("button");
  button.type = "button";
  button.className = spec.toggleClass;
  button.title = spec.title;
  button.setAttribute("aria-label", spec.ariaLabel);
  button.innerHTML = `<img class="customizer-icon" src="${spec.icon}" alt="" draggable="false">`;
  launcher.appendChild(button);
  host.appendChild(launcher);

  const ensure = (open = false) => {
    // Mode guard: an atelier only opens while its mode owns the slot.
    if (open && !spec.active()) return;
    if (open) openAfterLoad = true;
    if (selector) {
      if (open) selector.setOpen(true);
      return;
    }
    if (loading) return; // in-flight guard — double-press is idempotent
    loading = spec
      .load()
      .then((built) => {
        selector = built;
        launcher.hidden = true; // the real panel mounts its own toggle
        built.setVisible(spec.active());
        if (openAfterLoad && spec.active()) built.setOpen(true);
        openAfterLoad = false;
      })
      .catch(
        spec.onError ??
          ((error) => console.warn(`[selector] ${spec.id} failed to load`, error))
      )
      .finally(() => {
        loading = null;
      });
  };

  button.addEventListener("click", () => {
    spec.onLauncherClick?.();
    ensure(true);
  });

  const syncVisible = (show: boolean) => {
    if (!show) openAfterLoad = false; // leaving the slot cancels a pending open
    if (selector) {
      selector.setVisible(show);
      launcher.hidden = true;
    } else {
      launcher.hidden = !show;
    }
  };

  return {
    ensure,
    syncVisible,
    get: () => selector
  };
}

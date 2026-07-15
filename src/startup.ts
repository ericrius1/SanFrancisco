import { initialReadLink } from "./app/startupIntent";
import { openBehindTheScenes } from "./ui/behindTheScenesHost";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function startCityPrefetch(): void {
  document.documentElement.classList.remove("reading-entry");
  (globalThis as { __sfStartPrefetch?: () => void }).__sfStartPrefetch?.();
}

async function start(): Promise<void> {
  if (initialReadLink) {
    document.body.classList.add("reading");
    try {
      // The requested reading is the primary route: make its shell and selected
      // chapter usable, then let the normal city boot consume the background.
      await openBehindTheScenes(initialReadLink.sub, true);
      await nextFrame();
    } catch (error) {
      document.body.classList.remove("reading");
      console.warn("[bts] prioritized reader load failed; continuing to the city", error);
    }
  }

  startCityPrefetch();
  await import("./main");
}

void start().catch((error) => {
  console.error("[startup] fatal:", error);
  const label = document.querySelector<HTMLElement>("[data-loading-label]");
  if (label) label.textContent = `boot failed: ${error instanceof Error ? error.message : String(error)} — reload to retry`;
});

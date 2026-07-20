/**
 * "Wake the city" button (top-right, stacked under Share/Tutorial): only shown
 * in zone-only boot (`?zone=`). Clicking live-upgrades the pocket world to the
 * full city — main.ts owns the async wake; this button just drives the label
 * and removes itself when the wake resolves. Modeled 1:1 on ShareButton and it
 * reuses the shared `.share-btn` styling (see src/ui/share.ts).
 */
export class WakeCityButton {
  #root: HTMLDivElement;
  #btn: HTMLButtonElement;
  #label: HTMLSpanElement;

  constructor(onWake: () => Promise<void>) {
    this.#root = document.createElement("div");
    this.#root.className = "wake-city-ui";
    this.#btn = document.createElement("button");
    this.#btn.className = "share-btn";
    this.#btn.type = "button";
    this.#btn.title = "Load the rest of San Francisco around this spot";
    this.#btn.innerHTML = `<span class="ic">⛅</span><span class="wake-label">Wake the city</span>`;
    this.#label = this.#btn.querySelector(".wake-label")!;
    this.#btn.addEventListener("click", () => {
      if (this.#btn.disabled) return;
      this.#btn.disabled = true;
      this.#label.textContent = "Waking…";
      void onWake().finally(() => this.#root.remove());
    });
    this.#root.appendChild(this.#btn);
    document.getElementById("hud")!.appendChild(this.#root);
  }

  /** Programmatic wake (`__sf.wakeCity()`) must clear the button too. */
  remove(): void {
    this.#root.remove();
  }
}

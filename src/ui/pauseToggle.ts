/**
 * Pause control (bottom-center): appears only while the game is paused and the
 * UI is visible (hidden in immersive mode, since it lives under #hud). Pausing
 * freezes everything, player included — a dead-still world for a screenshot.
 * This toggle flips the "unfreeze the player" bit, so you can keep walking/
 * driving/flying around while the world holds still.
 */
export class PauseToggle {
  #root: HTMLDivElement;
  #btn: HTMLButtonElement;
  #label: HTMLSpanElement;
  #frozen = true;

  constructor(onToggle: (freezePlayer: boolean) => void) {
    this.#root = document.createElement("div");
    this.#root.className = "pause-ui";
    this.#root.style.display = "none";

    this.#btn = document.createElement("button");
    this.#btn.className = "share-btn pause-btn";
    this.#btn.type = "button";
    this.#btn.title = "Paused. Everything is frozen, player included — click to unfreeze the player and roam the still city.";
    this.#btn.innerHTML = `<span class="ic">⏸</span><span class="pause-label"></span>`;
    this.#label = this.#btn.querySelector(".pause-label")!;
    this.#btn.addEventListener("click", () => {
      this.#frozen = !this.#frozen;
      this.#render();
      onToggle(this.#frozen);
    });

    this.#root.appendChild(this.#btn);
    document.getElementById("hud")!.appendChild(this.#root);
    this.#render();
  }

  /** Show while paused (and not immersive); reset to "fully frozen" each pause. */
  setVisible(visible: boolean) {
    this.#root.style.display = visible ? "" : "none";
  }

  /** Reflect the external freeze-player state (P may reset it). */
  setFrozen(frozen: boolean) {
    if (frozen === this.#frozen) return;
    this.#frozen = frozen;
    this.#render();
  }

  #render() {
    this.#btn.classList.toggle("armed", this.#frozen);
    this.#label.textContent = this.#frozen ? "Everything frozen — click to move" : "Player live — click to freeze all";
  }
}

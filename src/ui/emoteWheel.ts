import { EMOTES, type EmoteId } from "../player/emotes";

/**
 * The emote picker: a ring of gestures that opens on J and picks with the
 * number keys.
 *
 * Deliberately keyboard-first. Every other radial menu in a browser game has to
 * choose between "release the pointer so you can click it" (which drops
 * mouselook and re-locks with a jolt) and "make the player aim with a captured
 * cursor" (which they cannot see). Number keys sidestep both: the ring is a
 * legend for 1–8, the pointer is never touched, and clicking still works for
 * anyone already in free-cursor mode.
 *
 * Pure DOM inside #hud. The wheel holds no emote state — it reports a pick and
 * the player owns what happens next, including the fact that re-picking the
 * running emote stops it. That is what the lit chip is telling you.
 */
export class EmoteWheel {
  #root: HTMLElement;
  #ring: HTMLElement;
  #open = false;
  #onPick: (id: EmoteId) => void;
  #buttons: HTMLButtonElement[] = [];

  constructor(onPick: (id: EmoteId) => void) {
    this.#onPick = onPick;
    const hud = document.getElementById("hud")!;
    this.#root = document.createElement("div");
    this.#root.className = "emote-wheel";
    this.#root.setAttribute("role", "menu");
    this.#root.setAttribute("aria-label", "Emotes");

    this.#ring = document.createElement("div");
    this.#ring.className = "emote-ring";

    // Lay the slots out clockwise from the top so the number order reads the
    // way a clock does, not the way atan2 does.
    const count = EMOTES.length;
    for (const [i, emote] of EMOTES.entries()) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "emote-slot";
      b.style.left = `${50 + Math.cos(angle) * 38}%`;
      b.style.top = `${50 + Math.sin(angle) * 38}%`;
      b.title = `${emote.label} (${i + 1})`;
      b.setAttribute("aria-label", emote.label);
      b.innerHTML =
        `<span class="ic">${emote.icon}</span>` +
        `<span class="lbl">${emote.label}</span>` +
        `<span class="num">${i + 1}</span>`;
      b.addEventListener("click", () => this.pick(i));
      this.#buttons.push(b);
      this.#ring.appendChild(b);
    }

    const hint = document.createElement("div");
    hint.className = "emote-hint";
    hint.innerHTML = `<span class="emote-hint-title">Emotes</span><span class="emote-hint-sub">1–8 · J closes</span>`;
    this.#ring.appendChild(hint);
    this.#root.appendChild(this.#ring);
    hud.appendChild(this.#root);
  }

  get open(): boolean {
    return this.#open;
  }

  setOpen(open: boolean) {
    if (this.#open === open) return;
    this.#open = open;
    this.#root.classList.toggle("open", open);
  }

  toggle() {
    this.setOpen(!this.#open);
  }

  /** Fire slot `index` (0-based) and close. Out-of-range indexes are ignored so
   *  the digit row can hand every press straight through. */
  pick(index: number) {
    const emote = EMOTES[index];
    if (!emote) return;
    this.setOpen(false);
    this.#onPick(emote.id);
  }

  /** Light the running emote, so reopening the wheel shows what is playing —
   *  and which number will stop it. */
  setActive(id: EmoteId | null) {
    for (const [i, b] of this.#buttons.entries()) {
      const on = EMOTES[i].id === id;
      b.classList.toggle("active", on);
      b.title = on ? `stop ${EMOTES[i].label} (${i + 1})` : `${EMOTES[i].label} (${i + 1})`;
    }
  }
}

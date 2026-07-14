/**
 * Ephemeral multiplayer text chat — bottom-left, above the audio panel.
 * Fire-and-forget over the presence relay (no history across refreshes).
 * T focuses the field; Enter sends; Esc blurs back to the game.
 */
export class Chat {
  #root: HTMLElement;
  #log: HTMLElement;
  #input: HTMLInputElement;
  #onSend: (text: string) => void;
  #onFocusChange: (focused: boolean) => void;
  #maxLines = 40;

  constructor(onSend: (text: string) => void, onFocusChange: (focused: boolean) => void = () => {}) {
    this.#onSend = onSend;
    this.#onFocusChange = onFocusChange;

    this.#root = document.createElement("div");
    this.#root.className = "chat";

    const head = document.createElement("div");
    head.className = "chat-head";
    const tag = document.createElement("span");
    tag.className = "chat-tag";
    tag.textContent = "The Wire";
    const hint = document.createElement("span");
    hint.className = "chat-hint";
    hint.textContent = "T";
    head.append(tag, hint);

    this.#log = document.createElement("div");
    this.#log.className = "chat-log";
    this.#log.setAttribute("aria-live", "polite");

    this.#input = document.createElement("input");
    this.#input.className = "chat-input";
    this.#input.type = "text";
    this.#input.maxLength = 200;
    this.#input.autocomplete = "off";
    this.#input.spellcheck = false;
    this.#input.placeholder = "say something…";
    this.#input.setAttribute("aria-label", "Chat message");

    this.#input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.#submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.blur();
      }
    });
    this.#input.addEventListener("focus", () => this.#onFocusChange(true));
    this.#input.addEventListener("blur", () => this.#onFocusChange(false));

    this.#root.append(head, this.#log, this.#input);
    document.getElementById("hud")!.appendChild(this.#root);
  }

  get focused() {
    return document.activeElement === this.#input;
  }

  focus() {
    this.#input.focus();
    this.#input.select();
  }

  blur() {
    this.#input.blur();
  }

  /** Local echo + remote messages share this path. */
  addMessage(name: string, text: string, self = false) {
    const row = document.createElement("div");
    row.className = self ? "chat-msg self" : "chat-msg";
    const who = document.createElement("span");
    who.className = "chat-who";
    who.textContent = name;
    const body = document.createElement("span");
    body.className = "chat-body";
    body.textContent = text;
    row.append(who, body);
    this.#log.appendChild(row);
    while (this.#log.childElementCount > this.#maxLines) this.#log.firstElementChild?.remove();
    this.#log.scrollTop = this.#log.scrollHeight;
  }

  #submit() {
    const text = this.#input.value.trim();
    this.#input.value = "";
    if (!text) {
      this.blur();
      return;
    }
    this.#onSend(text);
    this.blur();
  }
}

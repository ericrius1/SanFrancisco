/**
 * "Share spot" button (top-right, under the avatar toggle): copies an invite
 * link that drops a friend at the sharer's exact position, in the same kind
 * of vehicle. main.ts builds the URL (it owns position/mode/ride state) and
 * applies incoming ?j= links on boot.
 */
export class ShareButton {
  #label: HTMLSpanElement;
  #resetTimer: ReturnType<typeof setTimeout> | undefined;
  /** In zone-only boot, the shared link carries `zone=<id>` so recipients get
   * the same pocket boot at the shared spot. Cleared by wakeCity() (they are in
   * the full world then). */
  #zoneId: string | null = null;

  constructor(buildUrl: () => string, onCopied: (ok: boolean) => void) {
    const root = document.createElement("div");
    root.className = "share-ui";
    const btn = document.createElement("button");
    btn.className = "share-btn";
    btn.type = "button";
    btn.title = "Copy an invite link — a friend joins right here, in the same ride";
    btn.innerHTML = `<span class="ic">🔗</span><span class="share-label">Share spot</span>`;
    this.#label = btn.querySelector(".share-label")!;
    btn.addEventListener("click", () => {
      void this.#copy(this.#withZone(buildUrl())).then((ok) => {
        this.#flash(ok ? "Copied!" : "Copy failed");
        onCopied(ok);
      });
    });
    root.appendChild(btn);
    document.getElementById("hud")!.appendChild(root);
  }

  /** null = full world (default): shared links omit the zone param. */
  setZone(id: string | null) {
    this.#zoneId = id;
  }

  #withZone(url: string): string {
    if (!this.#zoneId) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}zone=${encodeURIComponent(this.#zoneId)}`;
  }

  async #copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // clipboard API needs focus + permission — fall back to a manual prompt
      try {
        return window.prompt("Copy the invite link:", text) !== null;
      } catch {
        return false;
      }
    }
  }

  #flash(text: string) {
    this.#label.textContent = text;
    clearTimeout(this.#resetTimer);
    this.#resetTimer = setTimeout(() => (this.#label.textContent = "Share spot"), 1800);
  }
}

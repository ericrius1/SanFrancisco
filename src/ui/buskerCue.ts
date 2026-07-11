/**
 * "Cue show" button (top-right stack): jumps the busker trio to one second
 * before the first note, without moving the player. For filming take resets.
 */
export class BuskerCueButton {
  constructor(onCue: () => void) {
    const root = document.createElement("div");
    root.className = "busker-cue-ui";
    const btn = document.createElement("button");
    btn.className = "share-btn";
    btn.type = "button";
    btn.title = "Reset the busker show to 1 second before they start playing";
    btn.innerHTML = `<span class="ic">🎵</span><span class="share-label">Cue show</span>`;
    btn.addEventListener("click", () => onCue());
    root.appendChild(btn);
    document.getElementById("hud")!.appendChild(root);
  }
}

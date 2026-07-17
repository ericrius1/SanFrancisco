// Escape priority stack — dismiss an open overlay (stay unlocked) before any
// other Escape behavior. Extracted from main.ts per docs/MAIN_DECOMPOSITION.md:
// window-level listener wiring with narrow callbacks into boot state.
import { getBehindTheScenes } from "../../ui/behindTheScenesHost";
import type { Input } from "../../core/input";
import type { Minimap } from "../../ui/minimap";
import type { Chat } from "../../ui/chat";
import type { MissionDoloresMuseum } from "../../world/missionDolores";

/**
 * Escape priority: dismiss an open overlay (stay unlocked). Pointer-lock exit
 * is the browser's job — do not call releaseLock here. Wire only after the
 * minimap exists so an early Esc can't hit a TDZ binding.
 *
 * Chrome may reserve the *locked* Escape keydown for its native pointer-lock
 * exit, so overlay dismissal also listens on keyup: one Esc both unlocks
 * (browser) and closes the overlay when the keydown was swallowed.
 */
export function wireEscapeStack({
  input,
  minimap,
  chat,
  closeConversation,
  getMissionDolores,
  markChatEscapeBlur
}: {
  input: Input;
  minimap: Minimap;
  chat: Chat;
  /** buskerTalk.close(): a conversation owns the screen — Esc leaves it first. */
  closeConversation: () => boolean;
  getMissionDolores: () => MissionDoloresMuseum | null;
  /** Esc-blur must not re-lock the pointer — flags the chat's blur handler. */
  markChatEscapeBlur: () => void;
}): void {
  const dismissEscapeOverlay = (e: KeyboardEvent): boolean => {
    const reader = getBehindTheScenes();
    const missionDolores = getMissionDolores();
    if (closeConversation()) {
      // A conversation owns the screen: Esc leaves it before any other overlay.
    } else if (missionDolores?.bookOpen) {
      missionDolores.closeBook();
    } else if (reader?.isOpen) {
      reader.setOpen(false);
    } else if (minimap.expanded) {
      minimap.setExpanded(false);
    } else {
      return false;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.code !== "Escape" && e.key !== "Escape") || e.repeat) return;
      const t = e.target;
      // Debug search / other fields keep their own Esc behavior.
      if (
        (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) &&
        !chat.focused
      ) {
        return;
      }
      if (dismissEscapeOverlay(e)) return;
      if (chat.focused) {
        markChatEscapeBlur();
        chat.blur();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    },
    true
  );
  // Keyup mirror: when Chrome swallowed the locked Escape keydown, the keyup is
  // still delivered here (pointer already released by then), so the overlay
  // closes on the same single Escape instead of needing a second press. Chat /
  // field clearing stays keydown-only — a focused field means the pointer is
  // unlocked, so that keydown is never swallowed.
  window.addEventListener(
    "keyup",
    (e) => {
      if (e.code !== "Escape" && e.key !== "Escape") return;
      dismissEscapeOverlay(e);
    },
    true
  );
  // Fullscreen Esc often exits fullscreen first and leaves pointer lock on —
  // drop the lock whenever fullscreen ends so one Esc is enough.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) input.releaseLock();
  });
}

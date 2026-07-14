/**
 * Deep-link registry for shareable HTML "reading" modals — the Behind-the-scenes
 * panel today, any future pop-up tomorrow. A modal registers itself under a
 * stable id; a `?read=<id>[.<sub>]` URL then drops a visitor straight into it
 * (optionally on a specific sub-view, e.g. a tab), and each modal can build a
 * link back to whatever it is currently showing.
 *
 * The scheme is intentionally tiny and generic:
 *   ?read=bts          → open the modal registered as "bts"
 *   ?read=bts.sound    → open it on sub-view "sound"
 *
 * main.ts owns the boot-time behaviour (skip the name gate, hand out a fun name,
 * then open the modal); this module is just the plumbing both sides share.
 */

export interface ShareableModal {
  /** Stable key used in the URL (?read=<id>). */
  readonly id: string;
  /** Open the modal, optionally at a sub-view (a tab id, a section, …). */
  open(sub?: string): void;
  /** The sub-view currently on screen, so a link can point back at it. */
  shareSub(): string | undefined;
}

const READ_PARAM = "read";
const registry = new Map<string, ShareableModal>();

export function registerShareable(m: ShareableModal): void {
  registry.set(m.id, m);
}

/** Parse `?read=bts.sound` → `{ id: "bts", sub: "sound" }` (sub optional). */
export function parseReadLink(search: string): { id: string; sub?: string } | null {
  const raw = new URLSearchParams(search).get(READ_PARAM);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  const id = dot < 0 ? raw : raw.slice(0, dot);
  const sub = dot < 0 ? undefined : raw.slice(dot + 1);
  if (!id) return null;
  return { id, sub };
}

/** Build a shareable URL to a modal (+ optional sub-view) on the deployed origin. */
export function buildReadUrl(id: string, sub?: string): string {
  const q = new URLSearchParams(location.search);
  q.delete("j"); // never carry an invite spawn into a reading link
  q.delete("via");
  q.set(READ_PARAM, sub ? `${id}.${sub}` : id);
  return `${location.origin}${location.pathname}?${q}`;
}

/**
 * If the URL carries a `?read=` link for a registered modal, open it. Returns
 * true if one was applied — main.ts uses that to know it should keep the game
 * running behind it. The modal owns the address bar from here on: it keeps
 * `?read=<id>.<sub>` in sync with the tab on screen (so the URL is always
 * shareable) and strips it when closed (so a refresh resumes normal play).
 */
export function openReadLink(): boolean {
  const link = parseReadLink(location.search);
  const modal = link && registry.get(link.id);
  if (!link || !modal) return false;
  modal.open(link.sub);
  return true;
}

/** Copy text to the clipboard, falling back to a manual prompt without focus. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      return window.prompt("Copy the link:", text) !== null;
    } catch {
      return false;
    }
  }
}

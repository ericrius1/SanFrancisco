export const BTS_X_URL = "https://x.com/EricLevin77";
export const BTS_REPO_URL = "https://github.com/ericrius1/SanFrancisco";

export const BTS_X_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
export const BTS_GH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.438 9.61 8.205 11.17.6.11.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.72-4.042-1.61-4.042-1.61-.546-1.385-1.332-1.755-1.332-1.755-1.09-.744.083-.729.083-.729 1.205.084 1.84 1.236 1.84 1.236 1.07 1.83 2.807 1.302 3.492.996.108-.775.418-1.303.762-1.603-2.665-.303-5.466-1.324-5.466-5.896 0-1.303.47-2.37 1.235-3.203-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.833 1.23 1.9 1.23 3.203 0 4.583-2.805 5.59-5.475 5.887.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.896 24 17.49 24 12.29 24 5.78 18.627.5 12 .5z"/></svg>`;

/**
 * Tiny, boot-safe launcher for the optional Behind-the-scenes reader. The
 * article and its interactive chapters stay out of the startup graph and are
 * requested only when the reader is opened.
 */
export class BehindTheScenesLauncher {
  #button: HTMLButtonElement;
  #label: HTMLSpanElement;
  #opening = false;

  constructor(open: () => Promise<void>, onError: (error: unknown) => void) {
    const hud = document.getElementById("hud")!;
    const ui = document.createElement("div");
    ui.className = "links-ui";

    this.#button = document.createElement("button");
    this.#button.className = "share-btn";
    this.#button.type = "button";
    this.#button.title = "How this city is built — the Blender pipeline, physics and multiplayer";
    this.#button.innerHTML = `<span class="ic">🎬</span><span>Behind the scenes</span>`;
    this.#label = this.#button.lastElementChild as HTMLSpanElement;

    this.#button.addEventListener("click", () => {
      if (this.#opening) return;
      this.#opening = true;
      this.#button.disabled = true;
      this.#button.setAttribute("aria-busy", "true");
      this.#label.textContent = "Loading…";
      void open()
        .catch(onError)
        .finally(() => {
          this.#opening = false;
          this.#button.disabled = false;
          this.#button.removeAttribute("aria-busy");
          this.#label.textContent = "Behind the scenes";
        });
    });

    const social = document.createElement("div");
    social.className = "social-row";
    social.appendChild(this.#iconLink(BTS_X_URL, "Follow on X / Twitter", BTS_X_ICON));
    social.appendChild(this.#iconLink(BTS_REPO_URL, "Source on GitHub", BTS_GH_ICON));

    ui.append(this.#button, social);
    hud.appendChild(ui);
  }

  #iconLink(href: string, title: string, svg: string): HTMLAnchorElement {
    const el = document.createElement("a");
    el.className = "social-btn";
    el.href = href;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
    el.title = title;
    el.innerHTML = svg;
    return el;
  }
}

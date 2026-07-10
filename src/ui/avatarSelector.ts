import {
  AVATAR_HAIR,
  AVATAR_HATS,
  AVATAR_OUTFITS,
  CLOTHING_COLORS,
  randomAvatarTraits,
  SKIN_TONES,
  type AvatarHair,
  type AvatarHat,
  type AvatarOutfit,
  type AvatarTraits
} from "../player/avatar";

type TraitKey = "hair" | "hat" | "outfit";

/**
 * Compact avatar editor living in the HUD. It emits complete trait objects so
 * the renderer and persistence layer stay the single owners of side effects.
 */
export class AvatarSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #traitsBody: HTMLElement;
  #nameInput!: HTMLInputElement;
  #nameBadge: HTMLDivElement;
  #toggle: HTMLButtonElement;
  #traits: AvatarTraits;
  #onChange: (traits: AvatarTraits) => void;
  #onRename: (name: string) => void;
  #open = false;

  constructor(
    initial: AvatarTraits,
    initialName: string,
    onChange: (traits: AvatarTraits) => void,
    onRename: (name: string) => void
  ) {
    this.#traits = { ...initial };
    this.#onChange = onChange;
    this.#onRename = onRename;

    const hud = document.getElementById("hud")!;
    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui";

    this.#toggle = document.createElement("button");
    this.#toggle.className = "avatar-toggle";
    this.#toggle.type = "button";
    this.#toggle.setAttribute("aria-controls", "avatar-editor");
    this.#toggle.setAttribute("aria-expanded", "false");
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#root.appendChild(this.#toggle);

    this.#nameBadge = document.createElement("div");
    this.#nameBadge.className = "player-name-chip";
    this.#nameBadge.dataset.playerName = "";
    this.#nameBadge.setAttribute("aria-label", "Current player name");
    this.#root.appendChild(this.#nameBadge);

    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel";
    this.#panel.id = "avatar-editor";
    // Name row is persistent (built once) so editing a trait — which rebuilds
    // the swatch/button grid — never blows away the field mid-type.
    this.#panel.appendChild(this.#buildNameRow(initialName));
    this.#traitsBody = document.createElement("div");
    this.#traitsBody.className = "avatar-traits";
    this.#panel.appendChild(this.#traitsBody);
    this.#root.appendChild(this.#panel);

    hud.appendChild(this.#root);
    this.setName(initialName);
    this.#render();
  }

  /** The "name" row: an editable field plus a dice that rolls a fun name. */
  #buildNameRow(initialName: string): HTMLElement {
    const input = document.createElement("input");
    this.#nameInput = input;
    input.className = "avatar-name-input";
    input.type = "text";
    input.maxLength = 20;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "your name";
    input.value = initialName;
    input.setAttribute("aria-label", "Your name");
    // commit on blur / Enter (Enter also drops focus back to the game)
    input.addEventListener("change", () => this.#onRename(input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });

    const roll = document.createElement("button");
    roll.type = "button";
    roll.className = "avatar-name-roll";
    roll.title = "Roll a fun name";
    roll.textContent = "🎲";
    // empty name → the rename callback (net.setName) hands back a fresh fun name
    roll.addEventListener("click", () => this.#onRename(""));

    const controls = document.createElement("div");
    controls.className = "avatar-controls";
    controls.append(input, roll);
    return this.#row("name", [], controls);
  }

  setOpen(open: boolean) {
    this.#open = open;
    this.#root.classList.toggle("open", open);
    this.#toggle.setAttribute("aria-expanded", String(open));
  }

  /** Reflect an externally-assigned avatar (e.g. the server's per-id seed once
   * the player is welcomed) without firing onChange. */
  setTraits(traits: AvatarTraits) {
    this.#traits = { ...traits };
    this.#render();
  }

  /** Reflect the current (possibly normalized) name without firing onRename. */
  setName(name: string) {
    this.#nameInput.value = name;
    const displayName = name.trim() || "Player";
    this.#nameBadge.textContent = displayName;
    this.#nameBadge.title = `You are ${displayName}`;
    this.#toggle.title = `Edit avatar and name (${displayName})`;
    this.#toggle.setAttribute("aria-label", `Edit avatar and name for ${displayName}`);
  }

  #set(next: Partial<AvatarTraits>) {
    this.#traits = { ...this.#traits, ...next };
    this.#render();
    this.#onChange({ ...this.#traits });
  }

  #button<T extends AvatarHair | AvatarHat | AvatarOutfit>(key: TraitKey, id: T, label: string) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-choice";
    b.textContent = label;
    b.classList.toggle("on", this.#traits[key] === id);
    b.addEventListener("click", () => this.#set({ [key]: id } as Partial<AvatarTraits>));
    return b;
  }

  #row(label: string, children: HTMLElement[], prebuilt?: HTMLElement) {
    const row = document.createElement("div");
    row.className = "avatar-row";
    const name = document.createElement("div");
    name.className = "avatar-label";
    name.textContent = label;
    let controls = prebuilt;
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "avatar-controls";
      for (const child of children) controls.appendChild(child);
    }
    row.append(name, controls);
    return row;
  }

  #swatch(kind: "skin" | "color" | "accent", index: number, color: number, label: string) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-swatch";
    b.title = label;
    b.style.background = `#${color.toString(16).padStart(6, "0")}`;
    b.classList.toggle("on", this.#traits[kind] === index);
    b.addEventListener("click", () => this.#set({ [kind]: index } as Partial<AvatarTraits>));
    return b;
  }

  #render() {
    const skin = SKIN_TONES[this.#traits.skin].color;
    const primary = CLOTHING_COLORS[this.#traits.color].color;
    const accent = CLOTHING_COLORS[this.#traits.accent].color;
    this.#toggle.innerHTML =
      `<span class="avatar-head" style="background:#${skin.toString(16).padStart(6, "0")}"></span>` +
      `<span class="avatar-shirt" style="background:#${primary.toString(16).padStart(6, "0")}"></span>` +
      `<span class="avatar-dot" style="background:#${accent.toString(16).padStart(6, "0")}"></span>`;

    this.#traitsBody.innerHTML = "";
    this.#traitsBody.append(
      this.#row(
        "skin",
        SKIN_TONES.map((s, i) => this.#swatch("skin", i, s.color, s.label))
      ),
      this.#row(
        "hair",
        AVATAR_HAIR.map((h) => this.#button("hair", h.id, h.label))
      ),
      this.#row(
        "hat",
        AVATAR_HATS.map((h) => this.#button("hat", h.id, h.label))
      ),
      this.#row(
        "clothes",
        AVATAR_OUTFITS.map((o) => this.#button("outfit", o.id, o.label))
      ),
      this.#row(
        "color",
        CLOTHING_COLORS.map((c, i) => this.#swatch("color", i, c.color, c.label))
      ),
      this.#row(
        "accent",
        CLOTHING_COLORS.map((c, i) => this.#swatch("accent", i, c.color, c.label))
      )
    );

    const random = document.createElement("button");
    random.type = "button";
    random.className = "avatar-random";
    random.textContent = "random";
    random.addEventListener("click", () => this.#set(randomAvatarTraits()));
    this.#traitsBody.appendChild(random);
  }
}

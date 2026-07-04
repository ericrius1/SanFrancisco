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
  #toggle: HTMLButtonElement;
  #traits: AvatarTraits;
  #onChange: (traits: AvatarTraits) => void;
  #open = false;

  constructor(initial: AvatarTraits, onChange: (traits: AvatarTraits) => void) {
    this.#traits = { ...initial };
    this.#onChange = onChange;

    const hud = document.getElementById("hud")!;
    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui";

    this.#toggle = document.createElement("button");
    this.#toggle.className = "avatar-toggle";
    this.#toggle.type = "button";
    this.#toggle.title = "Avatar";
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#root.appendChild(this.#toggle);

    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel";
    this.#root.appendChild(this.#panel);

    hud.appendChild(this.#root);
    this.#render();
  }

  setOpen(open: boolean) {
    this.#open = open;
    this.#root.classList.toggle("open", open);
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

  #row(label: string, children: HTMLElement[]) {
    const row = document.createElement("div");
    row.className = "avatar-row";
    const name = document.createElement("div");
    name.className = "avatar-label";
    name.textContent = label;
    const controls = document.createElement("div");
    controls.className = "avatar-controls";
    for (const child of children) controls.appendChild(child);
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

    this.#panel.innerHTML = "";
    this.#panel.append(
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
    this.#panel.appendChild(random);
  }
}

import * as THREE from "three/webgpu";

/**
 * A subtle stylized steam plume for the tea bowl — a small pool of soft sprite
 * puffs that rise from the cup rim, drift, swell and fade. Replaces the old
 * fake tube "strings". Cheap (one shared texture, a handful of billboards),
 * beauty-only (kept off the ink prepass layer), and self-recycling: no
 * allocations per frame.
 *
 * Parent it to the cup group so the plume tracks the cup as it moves between
 * the master's hands. Call `update(dt, active)` each frame; when `active` is
 * false the live puffs finish their rise and the plume goes quiet.
 */

export type TeaSteam = {
  group: THREE.Group;
  update(dt: number, active: boolean): void;
  dispose(): void;
};

function softPuffTexture(): THREE.CanvasTexture {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.45, "rgba(247,249,244,0.42)");
  g.addColorStop(1, "rgba(240,244,236,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type Puff = {
  life: number; // 0..1 up the plume
  rate: number; // 1/lifetime seconds
  x: number;
  z: number;
  swayPhase: number;
  swayAmp: number;
  spin: number;
};

export function createTeaSteam(count = 9): TeaSteam {
  const group = new THREE.Group();
  group.name = "tea_steam";
  const texture = softPuffTexture();
  const sprites: THREE.Sprite[] = [];
  const materials: THREE.SpriteMaterial[] = [];
  const puffs: Puff[] = [];

  const seed = (p: Puff, phase: number) => {
    p.life = phase;
    p.rate = 1 / (1.7 + phase * 0.6); // ~1.7–2.3 s to clear the plume
    p.x = (Math.random() - 0.5) * 0.05;
    p.z = (Math.random() - 0.5) * 0.05;
    p.swayPhase = Math.random() * Math.PI * 2;
    p.swayAmp = 0.018 + Math.random() * 0.02;
    p.spin = (Math.random() - 0.5) * 0.5;
  };

  for (let i = 0; i < count; i++) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: 0xf5f7ef,
      transparent: true,
      depthWrite: false,
      opacity: 0
    });
    material.fog = false;
    const sprite = new THREE.Sprite(material);
    sprite.name = `tea_steam_${i}`;
    sprite.frustumCulled = false;
    sprite.renderOrder = 24;
    sprite.layers.set(31); // beauty-only: stay out of the ink/outline prepass
    group.add(sprite);
    sprites.push(sprite);
    materials.push(material);
    const p: Puff = { life: 0, rate: 0, x: 0, z: 0, swayPhase: 0, swayAmp: 0, spin: 0 };
    seed(p, i / count); // stagger so the column reads continuous, not pulsed
    puffs.push(p);
  }

  let clock = 0;
  const smooth = (edge0: number, edge1: number, x: number) => {
    const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  return {
    group,
    update(dt: number, active: boolean) {
      const safeDt = Math.min(Math.max(dt, 0), 0.1);
      clock += safeDt;
      for (let i = 0; i < count; i++) {
        const p = puffs[i];
        const sprite = sprites[i];
        p.life += safeDt * p.rate;
        if (p.life >= 1) {
          if (active) seed(p, 0);
          else {
            sprite.visible = false;
            continue;
          }
        }
        sprite.visible = true;
        const rise = p.life * 0.32; // climbs ~32 cm
        const sway = Math.sin(clock * 1.3 + p.swayPhase) * p.swayAmp * (0.35 + p.life);
        sprite.position.set(p.x + sway, 0.055 + rise, p.z + Math.cos(clock * 1.1 + p.swayPhase) * p.swayAmp * 0.4);
        sprite.scale.setScalar(0.05 + p.life * 0.12); // billows outward as it cools
        sprite.material.rotation = p.swayPhase + clock * p.spin;
        const fadeIn = smooth(0, 0.16, p.life);
        const fadeOut = 1 - smooth(0.5, 1, p.life);
        sprite.material.opacity = fadeIn * fadeOut * 0.46;
      }
    },
    dispose() {
      group.removeFromParent();
      for (const m of materials) m.dispose();
      texture.dispose();
    }
  };
}

import type { MuseumCtx } from "../ctx";
import type { MdExhibit } from "./index";
import { WALL_ART_X, WALL_INNER_FACE_X } from "../layout";

// West-aisle "Canticle of the Creatures" gallery — seven wall plaques telling
// the verses of Francis's 1225 Canticle, descending the west wall from the
// narthex toward the altar, with a carved header sign and warm wall sconces.

const WALL_X = -WALL_ART_X;
const BOARD_W = 2.2;
const BOARD_H = 3.0;
const BOARD_Y = 2.6;
const GOLD = 0xd9a93b;
const WOOD = 0x5a3e26;
const TRIM = 0xe8d9bd;
const EMBER = 0xe8703a;

const HEADER_Z = -20.6;
const Z_START = -16.9; // first verse plaque
const Z_STEP = 4.6; // spacing down the wall

interface Verse {
  title: string;
  art: string;
  body: string;
  caption: string;
}

const VERSES: Verse[] = [
  {
    title: "Brother Sun",
    art: "canticle-brother-sun",
    body: "Every morning Francis greeted the sun like an old friend, calling it Brother Sun. He said its warm golden light was a gift from God, given freely to light every corner of the world.",
    caption: "Praised be You, my Lord, through Brother Sun, who is the day, and through whom You give us light."
  },
  {
    title: "Sister Moon & Stars",
    art: "canticle-sister-moon",
    body: "When night fell, Francis looked up and saw sisters in the sky — the gentle moon and countless twinkling stars. Their quiet light, he said, reminds us there is beauty to thank God for even in the dark.",
    caption: "Praised be You, my Lord, through Sister Moon and the stars, clear and precious and fair."
  },
  {
    title: "Brother Wind",
    art: "canticle-brother-wind",
    body: "Francis felt the wind on his face and called it Brother Wind, a playful spirit that pushes clouds across the sky and cools the hottest days. Even stormy weather, he said, was part of God's caring plan for the earth.",
    caption: "Praised be You, my Lord, through Brother Wind, and through air and cloud and every weather."
  },
  {
    title: "Sister Water",
    art: "canticle-sister-water",
    body: "Cool, clear, and humble, water was Sister Water to Francis — the same water that fills rivers, wells, and rain clouds. She asks for nothing and gives everything, quenching thirst and washing the whole world clean.",
    caption: "Praised be You, my Lord, through Sister Water, so useful, humble, precious and pure."
  },
  {
    title: "Brother Fire",
    art: "canticle-brother-fire",
    body: "At night Francis watched the fire's dancing flames and called it Brother Fire — strong, beautiful, and a little bit wild. It lights up the darkness and keeps travelers warm, just as Francis hoped his own life might light the way for others.",
    caption: "Praised be You, my Lord, through Brother Fire, by whom You light the night; he is beautiful and strong."
  },
  {
    title: "Sister Mother Earth",
    art: "canticle-sister-earth",
    body: "Beneath his bare feet Francis felt the ground itself, and he called her Sister Mother Earth. She feeds every creature with fruit, flowers, and grain, patiently caring for all her children the way a mother does.",
    caption: "Praised be You, my Lord, through our Sister Mother Earth, who feeds us and brings forth flowers and fruit."
  },
  {
    title: "All Creatures Sing",
    art: "canticle-creatures-all",
    body: "In the final verses of his Canticle, Francis invited every creature — sun, moon, wind, water, fire, and earth — to join in one great song of thanks. He believed the whole world was singing praise, if only we would stop to listen.",
    caption: "Praise and bless my Lord, and serve Him with great humbleness."
  }
];

export function createCanticleGallery(ctx: MuseumCtx): MdExhibit {
  const THREE = ctx.THREE;
  const grp = new THREE.Group();
  grp.name = "md_ex_canticleGallery";
  ctx.root.add(grp);

  // ---- carved header sign at the aisle entrance ----
  grp.add(
    ctx.makePlaque({
      title: "The Canticle of the Creatures",
      body: "Brother Francis's song of thanks for the world, composed near San Damiano in the last months of his life, around the year 1225.",
      pos: [WALL_X, 3.3, HEADER_Z],
      faceYaw: Math.PI / 2,
      w: 2.2,
      h: 1.2,
      accent: GOLD
    })
  );

  // ---- seven verse plaques, descending the west wall toward the altar ----
  const plaqueZs: number[] = VERSES.map((_, i) => Z_START + i * Z_STEP);
  VERSES.forEach((v, i) => {
    grp.add(
      ctx.makePlaque({
        title: v.title,
        body: v.body,
        art: v.art,
        caption: v.caption,
        pos: [WALL_X, BOARD_Y, plaqueZs[i]],
        faceYaw: Math.PI / 2,
        w: BOARD_W,
        h: BOARD_H,
        accent: GOLD
      })
    );
  });

  // ---- wood baseboard + pale picture rail running the length of the gallery ----
  const railZ0 = HEADER_Z - 1.2;
  const railZ1 = plaqueZs[plaqueZs.length - 1] + 1.2;
  const railLen = railZ1 - railZ0;
  const railCenterZ = (railZ0 + railZ1) / 2;

  const baseboard = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.3, railLen),
    ctx.glowMat(WOOD, 0.12, 0.85)
  );
  baseboard.position.set(-WALL_INNER_FACE_X + 0.06, 0.15, railCenterZ);
  grp.add(baseboard);

  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, railLen), ctx.glowMat(TRIM, 0.16, 0.6));
  rail.position.set(-WALL_INNER_FACE_X + 0.05, 4.3, railCenterZ);
  grp.add(rail);

  // ---- warm wall sconces between the plaques (emissive only — never a THREE light) ----
  const allZ = [HEADER_Z, ...plaqueZs];
  const sconceZs = allZ.slice(1).map((z, i) => (z + allZ[i]) / 2);

  const bracketGeo = new THREE.BoxGeometry(0.16, 0.16, 0.3);
  const bracketMat = ctx.glowMat(WOOD, 0.1, 0.8);
  const flameGeo = new THREE.SphereGeometry(0.11, 10, 8);
  const flameMat = ctx.glowMat(GOLD, 1.1, 0.4);
  const tipGeo = new THREE.ConeGeometry(0.07, 0.2, 8);
  const tipMat = ctx.glowMat(EMBER, 0.9, 0.4);

  for (const z of sconceZs) {
    const bracket = new THREE.Mesh(bracketGeo, bracketMat);
    bracket.position.set(WALL_X - 0.25, 4.5, z);
    grp.add(bracket);

    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(WALL_X + 0.05, 4.68, z);
    grp.add(flame);

    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.set(WALL_X + 0.05, 4.86, z);
    grp.add(tip);
  }

  return {
    dispose(): void {
      ctx.root.remove(grp);
      grp.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) m.dispose();
        }
      });
    }
  };
}

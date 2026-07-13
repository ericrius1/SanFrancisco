import * as THREE from "three/webgpu";
import type { MuseumCtx } from "../ctx";
import type { MdExhibit } from "./index";

// East-aisle "Life & Legacy" timeline — seven biographical stations hung on
// the east wall (x ≈ +11.55), read from the entrance (-z) toward the altar
// (+z): a chronological walk through the life of Francis of Assisi and the
// mission that carries his name.

const WALL_X = 13.05; // plaque board centre, mounted flush on the east outer wall (x = 13.5)
const RAIL_X = 12.9; // the bronze timeline rail + date medallions, slightly proud of the wall
const BOARD_W = 2.2;
const BOARD_H = 3.0;
const BOARD_LY = 2.6; // board centre height
const FACE_YAW = -Math.PI / 2; // east-wall art faces -x, into the nave
const Z_STEP = 4.6;
const Z_START = -19; // first (earliest) station

const GOLD = 0xd9a93b;
const WOOD = 0x5a3e26;
const TERRACOTTA = 0xa9573a;
const ROBE = 0x6a4a2e;

interface TimelineEntry {
  year: string;
  title: string;
  body: string;
  caption?: string;
  art?: string;
  accent: number;
}

const ENTRIES: TimelineEntry[] = [
  {
    year: "c. 1181",
    title: "A Merchant's Son",
    body:
      "Francesco di Bernardone was born in Assisi around 1181, the cherished son of a prosperous cloth merchant. " +
      "He loved fine clothes and troubadour songs, and rode off to war dreaming of glory as a knight. War, capture, " +
      "and a long illness slowly began to turn his heart toward something quieter.",
    caption: "Assisi, Umbria, Italy",
    art: "francis-portrait",
    accent: TERRACOTTA
  },
  {
    year: "c. 1205",
    title: "The Voice at San Damiano",
    body:
      "Praying before the crucifix in the crumbling little chapel of San Damiano, Francis heard Christ speak to him " +
      "from the icon. He took the words literally at first, and set about repairing the chapel stone by stone with " +
      "his own hands — not yet grasping the far larger Church he was truly called to renew.",
    caption: "“Go, Francis, rebuild my house, which you see is falling into ruin.”",
    art: "san-damiano",
    accent: GOLD
  },
  {
    year: "1206",
    title: "He Gives Everything Away",
    body:
      "When his father dragged him before the Bishop of Assisi to answer for money spent on the church, Francis " +
      "quietly removed every stitch of his clothing and handed it back. He declared he now had only one Father, in " +
      "heaven, and walked out of the square in a beggar's tunic — poor, and entirely free.",
    caption: "Before the Bishop's court, Assisi",
    art: "renounce-wealth",
    accent: TERRACOTTA
  },
  {
    year: "1209",
    title: "The Little Brothers",
    body:
      "A handful of companions gathered around Francis, drawn by his joy and his poverty. In 1209 Pope Innocent III " +
      "blessed their simple way of gospel life, and the Order of Friars Minor was born. Soon after, a young " +
      "noblewoman named Clare joined the movement and founded the Poor Clares.",
    caption: "A Rule of gospel simplicity, sealed with a Pope's blessing",
    accent: ROBE
  },
  {
    year: "1224",
    title: "The Wounds of La Verna",
    body:
      "On a retreat of prayer and fasting atop Mount La Verna, Francis beheld a vision of a seraph bearing the " +
      "crucified Christ. When the vision faded, he found upon his own hands, feet, and side the marks of the " +
      "Passion — the stigmata, the first such wounds recorded in Christian history.",
    caption: "September 1224, La Verna",
    art: "stigmata-la-verna",
    accent: GOLD
  },
  {
    year: "1226 · 1228",
    title: "Sister Death & Sainthood",
    body:
      "Nearly blind and worn thin by illness, Francis added a final verse to his Canticle welcoming “Sister " +
      "Bodily Death,” and died singing at Assisi on the night of October 3rd, 1226. So swiftly was he loved that " +
      "Pope Gregory IX declared him a saint barely two years later.",
    caption: "Feast day October 4 — patron of animals and ecology",
    accent: ROBE
  },
  {
    year: "1776",
    title: "A City Takes His Name",
    body:
      "Five and a half centuries later, Franciscan missionaries carried his name across an ocean. On June 29th, " +
      "1776 they founded Mission San Francisco de Asís beside a small lake, and the village — then the city — " +
      "that grew up around it kept the friar's name.",
    caption: "Mission San Francisco de Asís, still standing today",
    art: "mission-dolores",
    accent: GOLD
  }
];

export function createLifeTimeline(ctx: MuseumCtx): MdExhibit {
  const grp = new THREE.Group();
  grp.name = "md_ex_lifeTimeline";
  ctx.root.add(grp);

  // geometries/materials this exhibit constructs directly (not via ctx helpers,
  // which already register their own textures/materials for ctx.dispose()).
  const ownGeoms: THREE.BufferGeometry[] = [];
  const ownMats: THREE.Material[] = [];

  const zLast = Z_START + Z_STEP * (ENTRIES.length - 1);

  // ---- the bronze timeline rail running the length of the gallery ----
  const railMat = ctx.glowMat(GOLD, 0.3, 0.45);
  const railGeo = new THREE.BoxGeometry(0.07, 0.05, zLast - Z_START + 3.2);
  ownGeoms.push(railGeo);
  const rail = new THREE.Mesh(railGeo, railMat);
  rail.position.set(RAIL_X, 0.92, (Z_START + zLast) / 2);
  grp.add(rail);

  // ---- header sign at the entrance end of the gallery ----
  const headerTex = ctx.textTexture(
    [
      { text: "THE LIFE OF FRANCIS", font: "700 60px Georgia, 'Times New Roman', serif", color: "#f3e3bd", gap: 66 },
      { text: "a pilgrim's road — east aisle", font: "italic 32px Georgia, 'Times New Roman', serif", color: "#cbb27a" }
    ],
    { width: 900, height: 200, bg: "#3a2a16", align: "center" }
  );
  const headerMat = new THREE.MeshStandardMaterial({
    map: headerTex,
    emissiveMap: headerTex,
    emissive: 0xffffff,
    emissiveIntensity: 0.5,
    roughness: 0.85,
    metalness: 0
  });
  ownMats.push(headerMat);
  const headerGeo = new THREE.PlaneGeometry(1.7, 0.38);
  ownGeoms.push(headerGeo);
  const header = new THREE.Mesh(headerGeo, headerMat);
  header.rotation.y = FACE_YAW;
  header.position.set(WALL_X - 0.02, 4.35, Z_START - 2.6);
  grp.add(header);
  const headerFrameMat = ctx.glowMat(GOLD, 0.25, 0.5);
  const headerFrameGeo = new THREE.BoxGeometry(1.86, 0.5, 0.05);
  ownGeoms.push(headerFrameGeo);
  const headerFrame = new THREE.Mesh(headerFrameGeo, headerFrameMat);
  headerFrame.rotation.y = FACE_YAW;
  headerFrame.position.set(WALL_X + 0.03, 4.35, Z_START - 2.6);
  grp.add(headerFrame);

  // shared corbel + medallion-ring geometry/material (reused per station)
  const woodMat = ctx.glowMat(WOOD, 0.2, 0.8);
  const corbelTopGeo = new THREE.BoxGeometry(0.5, 0.08, 0.32);
  const corbelBotGeo = new THREE.BoxGeometry(0.3, 0.1, 0.2);
  ownGeoms.push(corbelTopGeo, corbelBotGeo);

  const ringMat = ctx.glowMat(GOLD, 0.32, 0.4);
  const ringGeo = new THREE.TorusGeometry(0.33, 0.028, 8, 28);
  const medGeo = new THREE.CircleGeometry(0.31, 32);
  ownGeoms.push(ringGeo, medGeo);

  for (let i = 0; i < ENTRIES.length; i++) {
    const entry = ENTRIES[i];
    const z = Z_START + i * Z_STEP;

    // ---- the plaque itself ----
    const plaque = ctx.makePlaque({
      title: entry.title,
      body: entry.body,
      art: entry.art,
      caption: entry.caption,
      w: BOARD_W,
      h: BOARD_H,
      pos: [WALL_X, BOARD_LY, z],
      faceYaw: FACE_YAW,
      accent: entry.accent
    });
    grp.add(plaque);

    // ---- little wood corbel "shelf" under the board ----
    const boardBottom = BOARD_LY - BOARD_H / 2;
    const corbelTop = new THREE.Mesh(corbelTopGeo, woodMat);
    corbelTop.position.set(WALL_X - 0.12, boardBottom - 0.04, z);
    grp.add(corbelTop);
    const corbelBot = new THREE.Mesh(corbelBotGeo, woodMat);
    corbelBot.position.set(WALL_X - 0.1, boardBottom - 0.15, z);
    grp.add(corbelBot);

    // ---- date medallion mounted on the rail ----
    const medTex = ctx.textTexture([{ text: entry.year, font: "700 78px Georgia, 'Times New Roman', serif", color: "#3f2f1c" }], {
      width: 220,
      height: 220,
      bg: "#e8d9bd",
      align: "center"
    });
    const medMat = new THREE.MeshStandardMaterial({
      map: medTex,
      emissiveMap: medTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.5,
      roughness: 0.8,
      metalness: 0.05
    });
    ownMats.push(medMat);
    const med = new THREE.Mesh(medGeo, medMat);
    med.rotation.y = FACE_YAW;
    med.position.set(RAIL_X - 0.02, 0.92, z);
    grp.add(med);

    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.y = FACE_YAW;
    ring.position.set(RAIL_X, 0.92, z);
    grp.add(ring);
  }

  return {
    dispose() {
      ctx.root.remove(grp);
      for (const g of ownGeoms) g.dispose();
      for (const m of ownMats) m.dispose();
    }
  };
}

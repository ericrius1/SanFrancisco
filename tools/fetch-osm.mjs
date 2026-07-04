// Downloads OSM data for the SF bbox from Overpass, chunked with retries.
// Output: data/raw/buildings-<i>.json, data/raw/roads.json, data/raw/land.json
import { mkdir, writeFile, access } from "node:fs/promises";
import { BBOX } from "./geo.mjs";

const OUT_DIR = new URL("../data/raw/", import.meta.url);
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

let endpointIndex = 0;

async function overpass(query, label) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[endpointIndex % ENDPOINTS.length];
    try {
      const started = Date.now();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "sf-city-game/0.1 (ericrius1@gmail.com)"
        },
        body: "data=" + encodeURIComponent(query)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      console.log(`[osm] ${label}: ${json.elements.length} elements in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return json;
    } catch (err) {
      endpointIndex++;
      const wait = 3000 * (attempt + 1);
      console.warn(`[osm] ${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`Overpass gave up on ${label}`);
}

function bboxStr(s, w, n, e) {
  return `${s},${w},${n},${e}`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const { south, west, north, east } = BBOX;

  // Buildings: 6x4 sub-boxes so single queries stay small.
  const COLS = 6;
  const ROWS = 4;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      const outPath = new URL(`buildings-${idx}.json`, OUT_DIR);
      if (await access(outPath).then(() => true, () => false)) {
        console.log(`[osm] buildings-${idx} cached, skip`);
        continue;
      }
      const s = south + ((north - south) * r) / ROWS;
      const n = south + ((north - south) * (r + 1)) / ROWS;
      const w = west + ((east - west) * c) / COLS;
      const e = west + ((east - west) * (c + 1)) / COLS;
      const bb = bboxStr(s, w, n, e);
      const query = `[out:json][timeout:180];(way["building"](${bb});relation["building"]["type"="multipolygon"](${bb}););out tags geom;`;
      const json = await overpass(query, `buildings-${idx}`);
      await writeFile(outPath, JSON.stringify(json));
      await new Promise((r2) => setTimeout(r2, 1200));
    }
  }

  const bb = bboxStr(south, west, north, east);

  const roadsPath = new URL("roads.json", OUT_DIR);
  if (!(await access(roadsPath).then(() => true, () => false))) {
    const roadQuery = `[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|pedestrian|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${bb});out tags geom;`;
    await writeFile(roadsPath, JSON.stringify(await overpass(roadQuery, "roads")));
    await new Promise((r) => setTimeout(r, 1200));
  } else {
    console.log("[osm] roads cached, skip");
  }

  const landPath = new URL("land.json", OUT_DIR);
  if (!(await access(landPath).then(() => true, () => false))) {
    const landQuery = `[out:json][timeout:180];(
      way["natural"="coastline"](${bb});
      way["natural"="water"](${bb});relation["natural"="water"](${bb});
      way["man_made"="pier"](${bb});relation["man_made"="pier"](${bb});
      way["leisure"~"^(park|garden|golf_course)$"](${bb});relation["leisure"~"^(park|garden|golf_course)$"](${bb});
      way["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground)$"](${bb});relation["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground)$"](${bb});
      way["natural"~"^(wood|scrub|sand|beach)$"](${bb});
    );out tags geom;`;
    await writeFile(landPath, JSON.stringify(await overpass(landQuery, "land")));
  } else {
    console.log("[osm] land cached, skip");
  }

  console.log("[osm] all done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

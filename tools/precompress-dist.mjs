// Pre-compress every compressible file in dist/ so the production server can
// serve precompressed .br / .gz siblings instead of compressing on-the-fly.
// Brotli quality 11 (max) + gzip level 9 for best wire size.
//
//   node tools/precompress-dist.mjs
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createBrotliCompress, createGzip, constants as zlibConstants } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".bin", ".svg", ".mjs", ".cjs"]);
const MIN_SIZE = 1024; // skip tiny files — overhead > saving

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function compress(filePath, outPath, factory) {
  await pipeline(createReadStream(filePath), factory(), createWriteStream(outPath));
}

let brCount = 0;
let gzCount = 0;
let brBytes = 0;
let gzBytes = 0;
let srcBytes = 0;

for await (const file of walk(DIST)) {
  // skip already-compressed siblings
  if (file.endsWith(".br") || file.endsWith(".gz")) continue;
  const ext = path.extname(file).toLowerCase();
  if (!COMPRESSIBLE.has(ext)) continue;
  const st = await stat(file);
  if (st.size < MIN_SIZE) continue;
  srcBytes += st.size;

  const brPath = file + ".br";
  await compress(file, brPath, () =>
    createBrotliCompress({
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 }
    })
  );
  const brSt = await stat(brPath);
  brBytes += brSt.size;
  brCount++;

  const gzPath = file + ".gz";
  await compress(file, gzPath, () => createGzip({ level: 9 }));
  const gzSt = await stat(gzPath);
  gzBytes += gzSt.size;
  gzCount++;
}

const pct = (n, d) => d ? ((100 * n) / d).toFixed(1) : "0";
console.log(
  `[precompress] wrote ${brCount} .br (${(brBytes / 1e6).toFixed(1)}MB, ${pct(brBytes, srcBytes)}% of src) ` +
  `+ ${gzCount} .gz (${(gzBytes / 1e6).toFixed(1)}MB, ${pct(gzBytes, srcBytes)}% of src) ` +
  `from ${(srcBytes / 1e6).toFixed(1)}MB source`
);

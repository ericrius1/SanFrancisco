/**
 * Loads the exported asset kit (public/assets/kit.glb + kit_manifest.json) and
 * renders placement lists as InstancedMeshes (one per unique mesh in each part).
 *
 * Materials are built from scratch from the source texture files — the GLB-embedded
 * materials come through as alpha-blended (depth-sorting breaks at grazing angles),
 * so they are replaced wholesale by name: building / floor / glass.
 */
// [SF vendor patch] import three from "three/webgpu" (shared core module instance
// with the host app under WebGPURenderer) and GLTFLoader from three/examples to
// match the host's loader path.
import {
  Group, InstancedMesh, Matrix4, Mesh, Object3D, DoubleSide, Color,
  BufferAttribute, BufferGeometry,
  MeshStandardMaterial, MeshPhysicalMaterial, Material, Texture, TextureLoader,
  SRGBColorSpace, NoColorSpace, RepeatWrapping,
} from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Placement } from "./generator";

function tex(loader: TextureLoader, url: string, srgb = false): Texture {
  const t = loader.load(url);
  t.flipY = false; // glTF UV convention
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

// [SF vendor patch] base path for the vendored textures (host stages them under
// /buildinggen/textures/ instead of the demo's /textures/).
function buildMaterials(texBase = "/textures"): Record<string, Material> {
  const loader = new TextureLoader();
  const building = new MeshStandardMaterial({
    name: "building",
    map: tex(loader, `${texBase}/Material_Base_color.png`, true),
    normalMap: tex(loader, `${texBase}/Material_Normal_OpenGL.png`),
    roughnessMap: tex(loader, `${texBase}/Material_Roughness.png`),
    roughness: 1,
    metalnessMap: tex(loader, `${texBase}/Material_Metallic.png`),
    metalness: 1,
    emissiveMap: tex(loader, `${texBase}/Material_Emissive.png`, true),
    emissive: new Color(0xffffff),
    emissiveIntensity: 1.4,
    side: DoubleSide,
  });
  const floor = new MeshStandardMaterial({
    name: "floor",
    map: tex(loader, `${texBase}/floor_Base_color.png`, true),
    normalMap: tex(loader, `${texBase}/floor_Normal_OpenGL.png`),
    roughnessMap: tex(loader, `${texBase}/floor_Roughness.png`),
    roughness: 1,
    metalnessMap: tex(loader, `${texBase}/floor_Metallic.png`),
    metalness: 1,
    emissiveMap: tex(loader, `${texBase}/floor_Base_Emissive.png`, true),
    emissive: new Color(0xffffff),
    emissiveIntensity: 1, // driven by the "emissive" slider in building settings (1–50)
    alphaMap: tex(loader, `${texBase}/floor_alpha.png`),
    alphaTest: 0.5, // cutout — no blend-sorting artifacts
    side: DoubleSide,
  });
  const glass = new MeshPhysicalMaterial({
    name: "glass",
    color: 0x9fb8c4,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: DoubleSide,
  });
  return { building, floor, glass };
}

interface ManifestCollection {
  children?: { index: number; kind: string; name: string }[];
  missing?: boolean;
}
interface Manifest {
  collections: Record<string, ManifestCollection>;
  objects: Record<string, unknown>;
}

const MIRROR_X = new Matrix4().makeScale(-1, 1, 1);

export class Kit {
  private parts = new Map<string, Object3D>();
  private manifest!: Manifest;
  private warned = new Set<string>();
  private mirrorCache = new Map<BufferGeometry, BufferGeometry>();
  /** dry (non-wet) clones of building/floor for interior parts — main.ts injects the
   *  rain wet shader into building/floor, and interiors (ROOMS/storeinside) must stay dry */
  private dryMaterials = new Map<Material, Material>();
  /** the from-scratch materials (building / floor / glass), set during load() */
  materials!: Record<string, Material>;
  /** when set, buildGroup adds a snow-shell pass (child group "snowShell") that
   *  shares geometry + instanceMatrix with the opaque meshes — zero extra memory */
  snowShellMaterial: Material | null = null;

  /**
   * Geometry with the X-mirror baked in (negated positions/normals/tangents,
   * reversed winding). Needed because InstancedMesh transforms normals with the
   * plain instance matrix: a reflection (negative determinant) flips winding, and
   * with DoubleSide the shader then negates the normal for "back" faces — so every
   * mirrored instance would be lit with inverted normals. Baking the mirror into
   * the geometry and cancelling it in the matrix keeps every determinant positive.
   */
  // [SF vendor patch] public — external batching (host BatchedMesh pools) needs the
  // same mirror-baked geometry variants that buildGroup uses internally.
  mirroredGeometry(src: BufferGeometry): BufferGeometry {
    let g = this.mirrorCache.get(src);
    if (g) return g;
    g = src.clone();
    for (const name of ["position", "normal", "tangent"]) {
      const attr = g.getAttribute(name) as BufferAttribute | undefined;
      if (!attr) continue;
      for (let i = 0; i < attr.count; i++) attr.setX(i, -attr.getX(i));
      if (name === "tangent" && attr.itemSize === 4) {
        for (let i = 0; i < attr.count; i++) attr.setW(i, -attr.getW(i));
      }
      attr.needsUpdate = true;
    }
    if (!g.index) {
      const n = g.getAttribute("position").count;
      const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) arr[i] = i;
      g.setIndex(new BufferAttribute(arr, 1));
    }
    const idx = g.index!;
    for (let i = 0; i + 2 < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    g.computeBoundingSphere();
    this.mirrorCache.set(src, g);
    return g;
  }

  count(collection: string): number {
    const c = this.manifest.collections[collection];
    return c?.children?.length || 1;
  }

  // [SF vendor patch] resolved render entries for a placement key: every mesh in
  // the part with its material (post-replacement) and its transform relative to
  // the part root — exactly what buildGroup computes internally, exposed so the
  // host can render placements through its own batching (BatchedMesh pools)
  // instead of per-building InstancedMeshes. Cached per key.
  private entryCache = new Map<string, { geometry: BufferGeometry; material: Material; meshLocal: Matrix4 }[] | null>();
  partMeshEntries(key: string): { geometry: BufferGeometry; material: Material; meshLocal: Matrix4 }[] | null {
    const hit = this.entryCache.get(key);
    if (hit !== undefined) return hit;
    const part = this.parts.get(key);
    if (!part) {
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`kit: missing part ${key}`);
      }
      this.entryCache.set(key, null);
      return null;
    }
    const entries: { geometry: BufferGeometry; material: Material; meshLocal: Matrix4 }[] = [];
    part.traverse(o => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const rootInv = new Matrix4().copy(part.matrixWorld).invert();
      const meshLocal = rootInv.multiply(mesh.matrixWorld);
      entries.push({ geometry: mesh.geometry, material: mesh.material as Material, meshLocal });
    });
    this.entryCache.set(key, entries);
    return entries;
  }

  /** Set the floor emissive intensity on BOTH the exterior floor material and its
   *  dry interior clone, so glowing rooms/storeinside track the "emissive" slider
   *  (they render with the dry clone to stay out of the rain wetness). */
  setFloorEmissive(v: number): void {
    const floor = this.materials?.floor as MeshStandardMaterial | undefined;
    if (floor) floor.emissiveIntensity = v;
    const dry = floor && (this.dryMaterials.get(floor) as MeshStandardMaterial | undefined);
    if (dry) dry.emissiveIntensity = v;
  }

  // [SF vendor patch] texBase threads the vendored texture directory through to
  // buildMaterials (default preserves the original demo path).
  async load(glbUrl: string, manifestUrl: string, texBase = "/textures"): Promise<void> {
    const [gltf, manifest] = await Promise.all([
      new GLTFLoader().loadAsync(glbUrl),
      fetch(manifestUrl).then(r => r.json() as Promise<Manifest>),
    ]);
    this.manifest = manifest;
    // GLTFLoader sanitizes Object3D names (strips [ ] . and spaces) — recover the
    // original glTF node names through the parser associations
    const json = gltf.parser.json as { nodes?: { name?: string }[] };
    const assoc = gltf.parser.associations as Map<Object3D, { nodes?: number }>;
    for (const child of [...gltf.scene.children]) {
      const a = assoc.get(child);
      const original = a?.nodes !== undefined ? json.nodes?.[a.nodes]?.name : undefined;
      this.parts.set(original ?? child.name, child);
      child.updateMatrixWorld(true);
    }
    // replace GLB-embedded materials with the from-scratch ones (matched by name;
    // Blender exports "building", "floor", "glass")
    const materials = buildMaterials(texBase);
    this.materials = materials;
    // dry clones for interior parts — cloned now (before main.ts injects the wet
    // shader into building/floor), so they never pick up the rain wetness
    this.dryMaterials.set(materials.building, materials.building.clone());
    this.dryMaterials.set(materials.floor, materials.floor.clone());
    const fallback = materials.building;
    gltf.scene.traverse(o => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const current = mesh.material as Material;
      const name = (current?.name ?? "").toLowerCase();
      let next = fallback;
      for (const key of Object.keys(materials)) {
        if (name.includes(key)) { next = materials[key]; break; }
      }
      mesh.material = next;
    });
  }

  /** Build a Group of InstancedMeshes from placements (matrices in Blender Z-up space). */
  buildGroup(placements: Placement[]): Group {
    const group = new Group();
    const byPart = new Map<string, Matrix4[]>();
    for (const pl of placements) {
      let list = byPart.get(pl.key);
      if (!list) byPart.set(pl.key, (list = []));
      list.push(pl.matrix);
    }

    // separate layer of duplicated (buffer-shared) meshes that the snow shader
    // extrudes — the base building geometry stays untouched
    const snowLayer = new Group();
    snowLayer.name = "snowShell";
    snowLayer.visible = false;

    const tmp = new Matrix4();
    for (const [key, matrices] of byPart) {
      // interior parts (rooms / store interiors) never see the sky — no snow shell,
      // and they use the dry material clone so the rain wetness skips them too
      const interior = key.includes("ROOMS") || key.includes("storeinside");
      const part = this.parts.get(key);
      if (!part) {
        if (!this.warned.has(key)) {
          this.warned.add(key);
          console.warn(`kit: missing part ${key}`);
        }
        continue;
      }
      part.traverse(o => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        // meshLocal = mesh transform relative to the part root (GLTFLoader splits
        // multi-material primitives into separate meshes, so material is single)
        const rootInv = new Matrix4().copy(part.matrixWorld).invert();
        const meshLocal = rootInv.multiply(mesh.matrixWorld);

        // split instances by determinant sign: mirrored placements get the
        // mirror baked into the geometry instead of the matrix (see mirroredGeometry)
        const plain: Matrix4[] = [];
        const mirrored: Matrix4[] = [];
        for (const m of matrices) {
          tmp.copy(m).multiply(meshLocal);
          if (tmp.determinant() < 0) mirrored.push(tmp.clone().multiply(MIRROR_X));
          else plain.push(tmp.clone());
        }
        for (const [geom, list] of [
          [mesh.geometry, plain],
          [mirrored.length ? this.mirroredGeometry(mesh.geometry) : null, mirrored],
        ] as const) {
          if (!geom || list.length === 0) continue;
          // interior meshes render with the dry clone (falls back to the original for
          // glass / anything not cloned) so the rain wet shader never touches them
          const baseMat = mesh.material as Material;
          const imMat = interior ? (this.dryMaterials.get(baseMat) ?? baseMat) : baseMat;
          const im = new InstancedMesh(geom, imMat, list.length);
          im.name = key; // e.g. COL[roof][2] — used by the hover inspector
          im.castShadow = true;
          im.receiveShadow = true;
          for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
          im.instanceMatrix.needsUpdate = true;
          group.add(im);

          // snow shell pass for opaque kit materials: same geometry, SAME
          // instanceMatrix buffer — only the vertex shader extrudes it
          if (this.snowShellMaterial && !interior &&
              (mesh.material === this.materials.building || mesh.material === this.materials.floor)) {
            const shell = new InstancedMesh(geom, this.snowShellMaterial, list.length);
            shell.instanceMatrix = im.instanceMatrix;
            shell.castShadow = false;
            shell.receiveShadow = true;
            snowLayer.add(shell);
          }
        }
      });
    }
    if (snowLayer.children.length) group.add(snowLayer);
    return group;
  }
}

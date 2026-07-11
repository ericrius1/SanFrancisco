import * as THREE from "three/webgpu";
import { float, normalView, positionViewDirection } from "three/tsl";

/**
 * A small set of intentional transparency modes. Effects should choose one of
 * these instead of assembling blending/depth flags ad hoc.
 */
export type TransparencyProfile =
  | "opaque"
  | "cutout"
  | "hashedCoverage"
  | "alphaSurface"
  | "additiveWorld"
  | "overlay";

/** Named render-order bands matching the scene's established ordering. */
export const RenderBand = {
  WORLD: 0,
  WATER_UNDERSIDE: 9,
  WATER_SURFACE: 10,
  WATER_OVERLAY: 10.5,
  WATER_NEAR: 11,
  WATER_EFFECTS: 12,
  DECALS: 20,
  DECAL_ADDITIVE: 21,
  WORLD_ADDITIVE: 90,
  WORLD_ADDITIVE_FRONT: 91,
  PARTICLES: 100,
  MARKER_BACK: 998,
  MARKERS: 999,
  OVERLAY: 1_000,
  DEBUG_OVERLAY: 9_999
} as const;

export type RenderBandValue = (typeof RenderBand)[keyof typeof RenderBand];

/**
 * Objects on this layer are rendered by the beauty pass but omitted from ink.
 * The beauty pass must enable layers 0 and 31; the ink pass should enable only
 * layer 0. `tagTransparency(..., { ink: false })` performs the object move.
 */
export const INK_EXCLUDED_LAYER = 31;

const DEFAULT_SCENE_LAYER = 0;
const OBJECT_TAG_KEY = "transparency";
const MATERIAL_PROFILE_KEY = "transparencyProfile";

const PROFILES: readonly TransparencyProfile[] = [
  "opaque",
  "cutout",
  "hashedCoverage",
  "alphaSurface",
  "additiveWorld",
  "overlay"
];

interface FixedFunctionPolicy {
  transparent: boolean;
  alphaHash: boolean;
  alphaTest: number;
  blending: THREE.Blending;
  depthTest: boolean;
  depthWrite: boolean;
  forceSinglePass: boolean;
}

const FIXED_FUNCTION_POLICY: Record<TransparencyProfile, FixedFunctionPolicy> = {
  opaque: {
    transparent: false,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: true,
    forceSinglePass: false
  },
  cutout: {
    transparent: false,
    alphaHash: false,
    alphaTest: 0.5,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: true,
    forceSinglePass: false
  },
  hashedCoverage: {
    transparent: false,
    alphaHash: true,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: true,
    forceSinglePass: false
  },
  alphaSurface: {
    transparent: true,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: false,
    forceSinglePass: false
  },
  additiveWorld: {
    transparent: true,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    // Additive blending is order-independent, so a double-sided material does
    // not benefit from Three's separate back/front draw calls.
    forceSinglePass: true
  },
  overlay: {
    transparent: true,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
    forceSinglePass: true
  }
};

const isTransparencyProfile = (value: unknown): value is TransparencyProfile =>
  typeof value === "string" && (PROFILES as readonly string[]).includes(value);

/**
 * Apply all transparency-related fixed-function state for a profile. Shader
 * content and authored appearance (`color`, `opacity`, and `side`) are retained.
 */
export function applyMaterialPolicy<T extends THREE.Material>(
  material: T,
  profile: TransparencyProfile
): T {
  const policy = FIXED_FUNCTION_POLICY[profile];
  const baseMaterial: THREE.Material = material;
  let changed = false;

  const set = <K extends keyof THREE.Material>(key: K, value: THREE.Material[K]) => {
    if (baseMaterial[key] === value) return;
    baseMaterial[key] = value;
    changed = true;
  };

  set("transparent", policy.transparent);
  set("alphaHash", policy.alphaHash);
  // Alpha-test thresholds are authored appearance, not blend state. Keep a
  // deliberate nonzero cutout threshold; 0.5 is only the policy default.
  const alphaTest = profile === "cutout" && material.alphaTest > 0
    ? material.alphaTest
    : policy.alphaTest;
  set("alphaTest", alphaTest);
  set("alphaToCoverage", false);
  set("premultipliedAlpha", false);
  set("blending", policy.blending);
  set("blendSrc", THREE.SrcAlphaFactor);
  set("blendDst", THREE.OneMinusSrcAlphaFactor);
  set("blendEquation", THREE.AddEquation);
  set("blendSrcAlpha", null);
  set("blendDstAlpha", null);
  set("blendEquationAlpha", null);
  set("blendAlpha", 0);
  set("depthFunc", THREE.LessEqualDepth);
  set("depthTest", policy.depthTest);
  set("depthWrite", policy.depthWrite);
  set("colorWrite", true);
  set("forceSinglePass", policy.forceSinglePass);

  if (!material.blendColor.equals(BLACK)) {
    material.blendColor.copy(BLACK);
    changed = true;
  }

  material.userData[MATERIAL_PROFILE_KEY] = profile;
  if (changed) material.needsUpdate = true;
  return material;
}

const BLACK = new THREE.Color(0, 0, 0);

export interface TransparencyTagOptions {
  profile: TransparencyProfile;
  renderBand?: number;
  /** Whether this object should contribute to the ink normal/depth prepass. */
  ink?: boolean;
}

export interface TransparencyTag {
  profile: TransparencyProfile;
  renderBand: number;
  ink: boolean;
}

/** Attach serializable policy metadata and configure render order/ink layer. */
export function tagTransparency<T extends THREE.Object3D>(
  object: T,
  options: TransparencyTagOptions
): T {
  const ink = options.ink ?? true;
  const renderBand = options.renderBand ?? object.renderOrder;

  if (options.renderBand !== undefined) object.renderOrder = options.renderBand;

  if (ink) {
    object.layers.disable(INK_EXCLUDED_LAYER);
    object.layers.enable(DEFAULT_SCENE_LAYER);
  } else {
    object.layers.disable(DEFAULT_SCENE_LAYER);
    object.layers.enable(INK_EXCLUDED_LAYER);
  }

  const tag: TransparencyTag = { profile: options.profile, renderBand, ink };
  object.userData[OBJECT_TAG_KEY] = tag;
  return object;
}

export type CoverageNode = THREE.Node<"float">;
export type CoverageInput = CoverageNode | number;

const asFloatNode = (value: CoverageInput): CoverageNode =>
  typeof value === "number" ? float(value) : float(value);

/** Clamp a scalar opacity/coverage expression before assigning it to a material. */
export function clampCoverage(node: CoverageInput): CoverageNode {
  return asFloatNode(node).clamp(0, 1);
}

/**
 * View-space Fresnel coverage. `floor` retains a controlled amount of face-on
 * coverage while the rim rises to one at grazing angles.
 */
export function fresnelCoverage(power: CoverageInput, floor: CoverageInput = 0): CoverageNode {
  const facing = normalView
    .normalize()
    .dot(positionViewDirection.normalize())
    .abs()
    .clamp(0, 1);
  const rim = facing.oneMinus().pow(asFloatNode(power).max(0));
  const base = clampCoverage(floor);
  return clampCoverage(base.add(rim.mul(base.oneMinus())));
}

export interface TransparencyAuditWarning {
  code: string;
  message: string;
  objectName: string;
  objectUuid: string;
  materialName: string;
  materialUuid: string;
  fields: string[];
}

export interface TransparencyAuditCounts {
  objectsVisited: number;
  renderableObjects: number;
  materialSlots: number;
  uniqueMaterials: number;
  transparentMaterials: number;
  hashedMaterials: number;
  taggedObjects: number;
  untaggedTransparentMaterials: number;
  untaggedHashedMaterials: number;
  warningCount: number;
  profiles: Record<TransparencyProfile, number>;
}

export interface TransparencyAudit {
  counts: TransparencyAuditCounts;
  warnings: TransparencyAuditWarning[];
}

const emptyProfileCounts = (): Record<TransparencyProfile, number> => ({
  opaque: 0,
  cutout: 0,
  hashedCoverage: 0,
  alphaSurface: 0,
  additiveWorld: 0,
  overlay: 0
});

const safeString = (value: unknown): string => {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    return "unknown error";
  }
};

const readObjectTag = (object: THREE.Object3D): TransparencyTag | null | false => {
  const value: unknown = object.userData[OBJECT_TAG_KEY];
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TransparencyTag>;
  if (
    !isTransparencyProfile(candidate.profile) ||
    typeof candidate.renderBand !== "number" ||
    !Number.isFinite(candidate.renderBand) ||
    typeof candidate.ink !== "boolean"
  ) {
    return false;
  }
  return candidate as TransparencyTag;
};

const readMaterialProfile = (material: THREE.Material): TransparencyProfile | null | false => {
  const value: unknown = material.userData[MATERIAL_PROFILE_KEY];
  if (value === undefined) return null;
  return isTransparencyProfile(value) ? value : false;
};

const materialList = (object: THREE.Object3D): THREE.Material[] => {
  const value: unknown = (object as THREE.Object3D & { material?: unknown }).material;
  const candidates = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return candidates.filter(
    (candidate): candidate is THREE.Material =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { isMaterial?: boolean }).isMaterial === true
  );
};

const materialMismatches = (
  material: THREE.Material,
  profile: TransparencyProfile
): string[] => {
  const policy = FIXED_FUNCTION_POLICY[profile];
  const mismatches: string[] = [];
  if (material.transparent !== policy.transparent) mismatches.push("transparent");
  if (material.alphaHash !== policy.alphaHash) mismatches.push("alphaHash");
  if (
    (profile === "cutout" && material.alphaTest <= 0) ||
    (profile !== "cutout" && material.alphaTest !== policy.alphaTest)
  ) {
    mismatches.push("alphaTest");
  }
  if (material.alphaToCoverage) mismatches.push("alphaToCoverage");
  if (material.premultipliedAlpha) mismatches.push("premultipliedAlpha");
  if (material.blending !== policy.blending) mismatches.push("blending");
  if (material.blendSrc !== THREE.SrcAlphaFactor) mismatches.push("blendSrc");
  if (material.blendDst !== THREE.OneMinusSrcAlphaFactor) mismatches.push("blendDst");
  if (material.blendEquation !== THREE.AddEquation) mismatches.push("blendEquation");
  if (material.blendSrcAlpha !== null) mismatches.push("blendSrcAlpha");
  if (material.blendDstAlpha !== null) mismatches.push("blendDstAlpha");
  if (material.blendEquationAlpha !== null) mismatches.push("blendEquationAlpha");
  if (material.blendAlpha !== 0) mismatches.push("blendAlpha");
  if (!material.blendColor.equals(BLACK)) mismatches.push("blendColor");
  if (material.depthFunc !== THREE.LessEqualDepth) mismatches.push("depthFunc");
  if (material.depthTest !== policy.depthTest) mismatches.push("depthTest");
  if (material.depthWrite !== policy.depthWrite) mismatches.push("depthWrite");
  if (material.colorWrite !== true) mismatches.push("colorWrite");
  if (material.forceSinglePass !== policy.forceSinglePass) mismatches.push("forceSinglePass");
  return mismatches;
};

/**
 * Inspect policy adoption and invalid transparency combinations. The audit is
 * diagnostic-only: malformed scene entries become warnings rather than throws,
 * and the returned object contains only JSON-serializable values.
 */
export function auditSceneTransparency(scene: THREE.Object3D): TransparencyAudit {
  const counts: TransparencyAuditCounts = {
    objectsVisited: 0,
    renderableObjects: 0,
    materialSlots: 0,
    uniqueMaterials: 0,
    transparentMaterials: 0,
    hashedMaterials: 0,
    taggedObjects: 0,
    untaggedTransparentMaterials: 0,
    untaggedHashedMaterials: 0,
    warningCount: 0,
    profiles: emptyProfileCounts()
  };
  const warnings: TransparencyAuditWarning[] = [];
  const seenObjects = new Set<THREE.Object3D>();
  const uniqueMaterials = new Set<THREE.Material>();
  const transparentMaterials = new Set<THREE.Material>();
  const hashedMaterials = new Set<THREE.Material>();
  const untaggedTransparentMaterials = new Set<THREE.Material>();
  const untaggedHashedMaterials = new Set<THREE.Material>();
  const stack: THREE.Object3D[] = [];

  const warn = (
    code: string,
    message: string,
    object?: THREE.Object3D,
    material?: THREE.Material,
    fields: string[] = []
  ) => {
    warnings.push({
      code,
      message,
      objectName: object?.name || object?.type || "",
      objectUuid: object?.uuid || "",
      materialName: material?.name || material?.type || "",
      materialUuid: material?.uuid || "",
      fields: [...fields]
    });
  };

  try {
    if (
      typeof scene !== "object" ||
      scene === null ||
      (scene as { isObject3D?: boolean }).isObject3D !== true
    ) {
      warn("invalid-scene", "Transparency audit received a non-Object3D scene.");
    } else {
      stack.push(scene);
    }

    while (stack.length > 0) {
      const object = stack.pop();
      if (!object || seenObjects.has(object)) continue;
      seenObjects.add(object);
      counts.objectsVisited += 1;

      try {
        const children = Array.isArray(object.children) ? object.children : [];
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child && (child as { isObject3D?: boolean }).isObject3D === true) stack.push(child);
        }

        const materials = materialList(object);
        if (materials.length === 0) continue;
        counts.renderableObjects += 1;
        counts.materialSlots += materials.length;

        const tag = readObjectTag(object);
        if (tag === false) {
          warn("invalid-object-tag", "Object transparency metadata is malformed.", object);
        } else if (tag !== null) {
          counts.taggedObjects += 1;
          counts.profiles[tag.profile] += 1;
          if (object.renderOrder !== tag.renderBand) {
            warn(
              "render-band-mismatch",
              `Tagged render band ${tag.renderBand} does not match renderOrder ${object.renderOrder}.`,
              object,
              undefined,
              ["renderOrder"]
            );
          }
          const onExcludedLayer = object.layers.isEnabled(INK_EXCLUDED_LAYER);
          const onDefaultLayer = object.layers.isEnabled(DEFAULT_SCENE_LAYER);
          if (
            (!tag.ink && (!onExcludedLayer || onDefaultLayer)) ||
            (tag.ink && (!onDefaultLayer || onExcludedLayer))
          ) {
            warn(
              "ink-layer-mismatch",
              `Ink metadata (${tag.ink}) does not match the object's layer mask.`,
              object,
              undefined,
              ["layers"]
            );
          }
        }

        for (const material of materials) {
          uniqueMaterials.add(material);
          if (material.transparent) transparentMaterials.add(material);
          if (material.alphaHash) hashedMaterials.add(material);

          const materialProfile = readMaterialProfile(material);
          if (materialProfile === false) {
            warn("invalid-material-tag", "Material transparency metadata is malformed.", object, material);
          }

          const effectiveProfile = tag !== null && tag !== false
            ? tag.profile
            : materialProfile !== null && materialProfile !== false
              ? materialProfile
              : null;

          if ((tag === null || tag === false) && material.transparent) {
            untaggedTransparentMaterials.add(material);
            warn(
              "untagged-transparent-material",
              "Transparent material is used by an object without transparency metadata.",
              object,
              material
            );
          }
          if ((tag === null || tag === false) && material.alphaHash) {
            untaggedHashedMaterials.add(material);
            warn(
              "untagged-alpha-hash-material",
              "Alpha-hashed material is used by an object without transparency metadata.",
              object,
              material
            );
          }

          if (
            tag !== null &&
            tag !== false &&
            materialProfile !== null &&
            materialProfile !== false &&
            tag.profile !== materialProfile
          ) {
            warn(
              "profile-tag-mismatch",
              `Object profile '${tag.profile}' differs from material profile '${materialProfile}'.`,
              object,
              material,
              ["profile"]
            );
          }

          if (material.alphaHash && material.transparent) {
            warn(
              "alpha-hash-transparent-conflict",
              "alphaHash and transparent must not be enabled together.",
              object,
              material,
              ["alphaHash", "transparent"]
            );
          }
          if (material.alphaHash && material.blending === THREE.AdditiveBlending) {
            warn(
              "alpha-hash-additive-conflict",
              "Alpha-hashed coverage cannot use additive blending.",
              object,
              material,
              ["alphaHash", "blending"]
            );
          }

          if (effectiveProfile) {
            const mismatches = materialMismatches(material, effectiveProfile);
            if (mismatches.length > 0) {
              warn(
                "material-policy-mismatch",
                `Material does not match the '${effectiveProfile}' fixed-function policy.`,
                object,
                material,
                mismatches
              );
            }
          }
        }
      } catch (error) {
        warn("object-audit-error", `Could not inspect object: ${safeString(error)}`, object);
      }
    }
  } catch (error) {
    warn("audit-error", `Transparency audit could not complete: ${safeString(error)}`);
  }

  counts.uniqueMaterials = uniqueMaterials.size;
  counts.transparentMaterials = transparentMaterials.size;
  counts.hashedMaterials = hashedMaterials.size;
  counts.untaggedTransparentMaterials = untaggedTransparentMaterials.size;
  counts.untaggedHashedMaterials = untaggedHashedMaterials.size;
  counts.warningCount = warnings.length;
  return { counts, warnings };
}

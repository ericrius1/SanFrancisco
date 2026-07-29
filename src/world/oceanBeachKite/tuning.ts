import type { FolderApi } from "tweakpane";
import { tunables } from "../../core/persist";

/**
 * One persisted schema for the whole encounter. Defaults, ranges, labels, and
 * pane grouping stay together so editing the feel automatically invalidates an
 * incompatible saved override instead of growing migration code.
 */
export const OCEAN_KITE_TUNING = tunables("oceanBeach.kite", {
  enabled: { v: true, label: "encounter enabled" },

  windStrength: { v: 1, min: 0.35, max: 2.2, step: 0.01, label: "wind strength" },
  /**
   * Downwind heading in compass degrees — the bearing the kite flies away on.
   * 292° is WNW, out over the water, which is the whole reason this encounter
   * disagrees with the global onshore vegetation wind: a single-line kite shows
   * its face to its flyer and nobody else, so a kite blown inland can never
   * share a frame with the sunset. Ocean Beach's evening land breeze does turn
   * offshore, and this is that evening.
   */
  windBearing: { v: 292, min: 0, max: 359, step: 1, label: "site wind bearing (°)" },
  gustResponse: { v: 0.62, min: 0, max: 1.5, step: 0.01, label: "gust response" },
  lift: { v: 0.78, min: 0.2, max: 1.35, step: 0.01, label: "kite lift" },
  drag: { v: 0.34, min: 0.05, max: 1.2, step: 0.01, label: "air drag" },

  lineTautness: { v: 0.76, min: 0.05, max: 1, step: 0.01, label: "line tautness" },
  minLineLength: { v: 18, min: 9, max: 28, step: 0.5, label: "minimum line (m)" },
  maxLineLength: { v: 38, min: 30, max: 64, step: 0.5, label: "maximum line (m)" },
  reelRate: { v: 3.4, min: 0.4, max: 10, step: 0.1, label: "reel speed (m/s)" },

  clothTautness: { v: 0.68, min: 0, max: 1, step: 0.01, label: "cloth tautness" },
  clothBillow: { v: 0.34, min: 0, max: 0.8, step: 0.01, label: "cloth billow (m)" },
  clothRipple: { v: 0.16, min: 0, max: 0.5, step: 0.01, label: "fine ripple (m)" },
  clothFrequency: { v: 4.2, min: 1, max: 9, step: 0.1, label: "ripple frequency" },
  clothSpeed: { v: 5.4, min: 0.5, max: 12, step: 0.1, label: "ripple speed" },

  slowRunSpeed: { v: 1.55, min: 0.5, max: 3.5, step: 0.05, label: "slow run (m/s)" },
  fastRunSpeed: { v: 4.85, min: 2, max: 8, step: 0.05, label: "fast run (m/s)" },
  actionTempo: { v: 1, min: 0.35, max: 2.2, step: 0.05, label: "behavior tempo" },
  runSpan: { v: 34, min: 12, max: 72, step: 1, label: "run span (m)" },
  beachDepth: { v: 26, min: 10, max: 60, step: 1, label: "sand depth (m)" },
  turnRate: { v: 1.05, min: 0.2, max: 2.6, step: 0.05, label: "base turn (rad/s)" },
  steerAuthority: { v: 1, min: 0, max: 2, step: 0.05, label: "steering authority" },

  sunsetAir: { v: true, label: "sunset air" },
  mistDensity: { v: 1, min: 0, max: 1.6, step: 0.02, label: "sea mist" },
  shaftStrength: { v: 0.9, min: 0, max: 2, step: 0.02, label: "kite light shafts" },
  clothBacklight: { v: 1, min: 0, max: 2, step: 0.02, label: "cloth transmission" },
  volumetricRays: { v: true, label: "raymarched god rays" },

  /**
   * The prism kite's dispersed spectrum: the beam in, the rainbow fan out and
   * the smear it lays on the sand. It rides on top of `shaftStrength` rather
   * than beside it — a shot that thins the light out should thin this out too —
   * and this dial is the ratio between them.
   */
  prismLight: { v: true, label: "prism spectrum" },
  prismStrength: { v: 1, min: 0, max: 2.5, step: 0.02, label: "prism strength" },

  showLandmarks: { v: false, label: "attachment landmarks" }
});

type OceanKiteTuningKey = keyof typeof OCEAN_KITE_TUNING.values;

/** Folder metadata belongs to the same source location as the value schema. */
const OCEAN_KITE_TUNING_FOLDERS: readonly {
  title: string;
  expanded?: boolean;
  keys: OceanKiteTuningKey[];
}[] = [
  {
    title: "wind",
    keys: ["enabled", "windStrength", "windBearing", "gustResponse", "lift", "drag"]
  },
  {
    title: "tether & reel",
    keys: ["lineTautness", "minLineLength", "maxLineLength", "reelRate"]
  },
  {
    title: "purple cloth · GPU",
    keys: ["clothTautness", "clothBillow", "clothRipple", "clothFrequency", "clothSpeed"]
  },
  {
    title: "flyer behavior",
    keys: [
      "slowRunSpeed",
      "fastRunSpeed",
      "actionTempo",
      "runSpan",
      "beachDepth",
      "turnRate",
      "steerAuthority"
    ]
  },
  {
    title: "sunset · mist & god rays",
    keys: [
      "sunsetAir",
      "mistDensity",
      "shaftStrength",
      "clothBacklight",
      "volumetricRays",
      "prismLight",
      "prismStrength"
    ]
  },
  {
    title: "debug / overlays",
    keys: ["showLandmarks"]
  }
];

export function bindOceanKiteTuning(folder: FolderApi): void {
  for (const section of OCEAN_KITE_TUNING_FOLDERS) {
    const child = folder.addFolder({
      title: section.title,
      expanded: section.expanded ?? false
    });
    OCEAN_KITE_TUNING.bind(child, { keys: section.keys });
  }
}

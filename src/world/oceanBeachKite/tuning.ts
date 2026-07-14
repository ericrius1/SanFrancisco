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
    expanded: true,
    keys: ["enabled", "windStrength", "gustResponse", "lift", "drag"]
  },
  {
    title: "tether & reel",
    expanded: true,
    keys: ["lineTautness", "minLineLength", "maxLineLength", "reelRate"]
  },
  {
    title: "purple cloth · GPU",
    expanded: true,
    keys: ["clothTautness", "clothBillow", "clothRipple", "clothFrequency", "clothSpeed"]
  },
  {
    title: "flyer behavior",
    keys: ["slowRunSpeed", "fastRunSpeed", "actionTempo", "runSpan"]
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

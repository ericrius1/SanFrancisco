import type { FolderApi } from "tweakpane";
import { tunables } from "../../core/persist";

/**
 * One persisted schema for the pianist's shoreline. Defaults, limits, labels,
 * and pane grouping stay together so the "." reset always returns the effect
 * to the authored show look without carrying an older control shape forward.
 */
export const BEACH_PIANIST_SHORELINE_TUNING = tunables("beachPianist.shoreline", {
  enabled: { v: true, label: "shoreline enabled" },

  waveHeight: { v: 0.105, min: 0.025, max: 0.22, step: 0.005, label: "wave height (m)" },
  crestSpacing: { v: 15, min: 8, max: 28, step: 0.25, label: "crest spacing (m)" },
  lapSpeed: { v: 0.76, min: 0.2, max: 1.5, step: 0.01, label: "lapping speed" },

  bioluminescence: { v: 1.35, min: 0, max: 3, step: 0.05, label: "crest glow" },
  surfaceSparkle: { v: 1.45, min: 0, max: 3, step: 0.05, label: "surface sparkle" },

  sparkleAmount: { v: 1.65, min: 0, max: 2, step: 0.05, label: "sparkle amount" },
  sparkleBrightness: { v: 1.3, min: 0, max: 2.5, step: 0.05, label: "sparkle brightness" },
  sparkleSize: { v: 1.15, min: 0.25, max: 2.5, step: 0.05, label: "sparkle size" },
  twinkleSpeed: { v: 1, min: 0.2, max: 2.5, step: 0.05, label: "twinkle speed" },

  collectiveLight: { v: 1, min: 0, max: 2, step: 0.05, label: "pianist glow light" }
});

type ShorelineTuningKey = keyof typeof BEACH_PIANIST_SHORELINE_TUNING.values;

const SHORELINE_TUNING_FOLDERS: readonly {
  title: string;
  expanded?: boolean;
  keys: ShorelineTuningKey[];
}[] = [
  {
    title: "gentle waves",
    expanded: true,
    keys: ["enabled", "waveHeight", "crestSpacing", "lapSpeed"]
  },
  {
    title: "bioluminescence",
    expanded: true,
    keys: ["bioluminescence", "surfaceSparkle"]
  },
  {
    title: "particles",
    expanded: true,
    keys: ["sparkleAmount", "sparkleBrightness", "sparkleSize", "twinkleSpeed"]
  },
  {
    title: "lighting",
    keys: ["collectiveLight"]
  }
];

export function bindBeachPianistShorelineTuning(folder: FolderApi): void {
  for (const section of SHORELINE_TUNING_FOLDERS) {
    const child = folder.addFolder({
      title: section.title,
      expanded: section.expanded ?? false
    });
    BEACH_PIANIST_SHORELINE_TUNING.bind(child, { keys: section.keys });
  }
}

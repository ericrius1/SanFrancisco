import {
  ScriptedDialogueProvider,
  type DialogueProvider,
  type DialogueSpeaker,
  type DialogueTurn
} from "../../gameplay/agents/dialogue";
import type { TeaGardenTourStopId } from "./layout";

export const TEA_MASTER_SPEAKER: DialogueSpeaker = {
  id: "tea-master-iroh",
  name: "Iroh",
  title: "Tea master · garden keeper"
} as const;

export type TeaGardenDialogueChapter = "welcome" | TeaGardenTourStopId | "farewell";

/**
 * Feature-level dialogue seam. A future model-backed source can construct a
 * fresh provider for each chapter while the guide controller keeps ownership
 * of movement, progress, presentation, and interruption.
 */
export interface TeaGardenDialogueSource {
  providerFor(chapter: TeaGardenDialogueChapter): DialogueProvider;
}

type ScriptTurn = Omit<DialogueTurn, "speaker">;

function turns(chapter: TeaGardenDialogueChapter, entries: readonly ScriptTurn[]): readonly DialogueTurn[] {
  return entries.map((entry) => ({ ...entry, speaker: TEA_MASTER_SPEAKER }));
}

const WELCOME = turns("welcome", [
  {
    id: "welcome-1",
    text: "Welcome, traveler. I am Iroh. This garden has been expecting your footsteps, though it is far too polite to say so aloud.",
    metadata: {
      topic: "A bowl before the path",
      nextHint: "E · Accept tea",
      tags: ["action:welcome"]
    }
  },
  {
    id: "welcome-2",
    text: "Please—warm your hands around this cup. Tea asks almost nothing of us: only enough stillness to notice that the world is already speaking.",
    metadata: {
      topic: "A bowl before the path",
      nextHint: "E · Take a sip",
      tags: ["action:serve"]
    }
  },
  {
    id: "welcome-3",
    text: "Good. We will visit five places together. Stay near me on the paths; I would rather wait for a friend than hurry through a garden.",
    metadata: {
      topic: "Five garden stories",
      nextHint: "E · Begin the tour",
      tags: ["action:talk"]
    }
  }
]);

const TEA_HOUSE = turns("tea-house", [
  {
    id: "tea-house-1",
    text: "The garden began as the Japanese Village for San Francisco’s 1894 Midwinter Exposition. Makoto Hagiwara helped make the temporary display permanent, and his family cared for it for decades.",
    metadata: {
      topic: "Tea House & the Hagiwaras",
      landmarkId: "tea-house",
      progress: { current: 1, total: 5, label: "Tour stop" },
      nextHint: "E · Continue",
      tags: ["action:point"]
    }
  },
  {
    id: "tea-house-2",
    text: "Makoto died in 1925. In 1942, his surviving family was forced from its garden home as Japanese Americans were incarcerated during World War II. Their stewardship still lives in these paths, ponds, and clipped trees.",
    metadata: {
      topic: "Tea House & the Hagiwaras",
      landmarkId: "tea-house",
      progress: { current: 1, total: 5, label: "Tour stop" },
      nextHint: "E · Walk to the Drum Bridge",
      tags: ["action:talk"]
    }
  }
]);

const DRUM_BRIDGE = turns("drum-bridge", [
  {
    id: "drum-bridge-1",
    text: "This is the taiko bashi—the Drum Bridge. Craftsman Shinshichi Nakatani came from Japan to build it for the 1894 exposition, shaping a crossing that asks us to slow down.",
    metadata: {
      topic: "Drum Bridge",
      landmarkId: "drum-bridge",
      progress: { current: 2, total: 5, label: "Tour stop" },
      nextHint: "E · Look into the water",
      tags: ["action:point"]
    }
  },
  {
    id: "drum-bridge-2",
    text: "See how its high half-circle meets its reflection? Bridge and water complete the round body of a drum. The steep climb turns an ordinary crossing into a small ceremony of balance and attention.",
    metadata: {
      topic: "Drum Bridge",
      landmarkId: "drum-bridge",
      progress: { current: 2, total: 5, label: "Tour stop" },
      nextHint: "E · Walk to Pagoda Plaza",
      tags: ["action:talk"]
    }
  }
]);

const PAGODA = turns("pagoda-pines", [
  {
    id: "pagoda-1",
    text: "The five-story pagoda was made for the 1915 Panama-Pacific International Exposition and moved here in 1916. In Buddhist architecture, a pagoda is a treasure tower—each roof lifting the eye a little higher.",
    metadata: {
      topic: "Pagoda Plaza & Black Pines",
      landmarkId: "pagoda-pines",
      progress: { current: 3, total: 5, label: "Tour stop" },
      nextHint: "E · Continue",
      tags: ["action:point"]
    }
  },
  {
    id: "pagoda-2",
    text: "A major restoration finished in 2022. The surrounding plaza followed in 2024, pairing permeable stone paving and Tatsuyama boulders with seven Japanese black pines, each already about sixty years old.",
    metadata: {
      topic: "Pagoda Plaza & Black Pines",
      landmarkId: "pagoda-pines",
      progress: { current: 3, total: 5, label: "Tour stop" },
      nextHint: "E · Walk to the dry garden",
      tags: ["action:talk"]
    }
  }
]);

const DRY_LANDSCAPE = turns("dry-landscape", [
  {
    id: "dry-landscape-1",
    text: "Landscape architect Nagao Sakurai designed this dry landscape garden in 1953. Its raked gravel can become flowing water in the mind; the stones may become islands, mountains, or something only you can name.",
    metadata: {
      topic: "Dry Landscape Garden",
      landmarkId: "dry-landscape",
      progress: { current: 4, total: 5, label: "Tour stop" },
      nextHint: "E · Listen",
      tags: ["action:point"]
    }
  },
  {
    id: "dry-landscape-2",
    text: "Nothing here is literally moving, yet light, shadow, rain, and your own attention remake it every day. A still garden can have excellent weather.",
    metadata: {
      topic: "Dry Landscape Garden",
      landmarkId: "dry-landscape",
      progress: { current: 4, total: 5, label: "Tour stop" },
      nextHint: "E · Walk to the ginkgoes",
      tags: ["action:talk"]
    }
  }
]);

const GINKGOES = turns("survivor-ginkgoes", [
  {
    id: "ginkgoes-1",
    text: "These two young ginkgoes were planted in 2019. They descend from trees that survived the atomic bombing of Hiroshima in 1945—living gifts of remembrance and renewal.",
    metadata: {
      topic: "Hiroshima-descendant Ginkgoes",
      landmarkId: "survivor-ginkgoes",
      progress: { current: 5, total: 5, label: "Tour stop" },
      nextHint: "E · Continue",
      tags: ["action:point"]
    }
  },
  {
    id: "ginkgoes-2",
    text: "Ginkgo is the sole living member of an ancient plant lineage more than two hundred million years old. A single fan-shaped leaf can hold deep time, human grief, and a stubborn green future.",
    metadata: {
      topic: "Hiroshima-descendant Ginkgoes",
      landmarkId: "survivor-ginkgoes",
      progress: { current: 5, total: 5, label: "Tour stop" },
      nextHint: "E · Finish the tour",
      tags: ["action:talk"]
    }
  }
]);

const FAREWELL = turns("farewell", [
  {
    id: "farewell-1",
    text: "That is our fifth story. But a garden is not a book that ends—it is a conversation that changes whenever a bird lands, a maple turns, or someone chooses to notice.",
    metadata: {
      topic: "The path continues",
      nextHint: "E · Say farewell",
      tags: ["action:welcome"]
    }
  },
  {
    id: "farewell-2",
    text: "Thank you for walking with me. Wander as long as you like. I will return to the Tea House, where the kettle and I will be practicing patience.",
    metadata: {
      topic: "The path continues",
      nextHint: "E · Let Iroh return",
      tags: ["action:talk"]
    }
  }
]);

/** Deterministic content; providers are recreated so every tour starts cleanly. */
export const TEA_GARDEN_SCRIPT: Readonly<Record<TeaGardenDialogueChapter, readonly DialogueTurn[]>> = {
  welcome: WELCOME,
  "tea-house": TEA_HOUSE,
  "drum-bridge": DRUM_BRIDGE,
  "pagoda-pines": PAGODA,
  "dry-landscape": DRY_LANDSCAPE,
  "survivor-ginkgoes": GINKGOES,
  farewell: FAREWELL
};

export class ScriptedTeaGardenDialogueSource implements TeaGardenDialogueSource {
  providerFor(chapter: TeaGardenDialogueChapter): DialogueProvider {
    return new ScriptedDialogueProvider(TEA_GARDEN_SCRIPT[chapter]);
  }
}

export function createScriptedTeaGardenDialogueSource(): TeaGardenDialogueSource {
  return new ScriptedTeaGardenDialogueSource();
}

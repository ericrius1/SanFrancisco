import * as THREE from "three/webgpu";
import { NpcConversation } from "../../gameplay/agents/conversation";
import { DialogueGraphProvider, type DialogueSpeaker } from "../../gameplay/agents/dialogue";

export const BEACH_PIANIST_SPEAKER: DialogueSpeaker = {
  id: "marshalls-beach-pianist",
  name: "Pianist",
  title: "Marshall's Beach"
};

export type BeachPianistConversationHost = {
  readonly group: THREE.Object3D;
  readonly anchor: THREE.Object3D;
  readonly awaitingRequest: () => boolean;
  readonly requestPerformance: () => boolean;
};

/** The pianist asks permission every time. A confirmed Yes starts exactly one
 * performance; both replies end the conversation immediately so the dialogue
 * card gets out of the way of the music. */
export function createBeachPianistConversation(
  host: BeachPianistConversationHost
): NpcConversation {
  return new NpcConversation({
    speaker: BEACH_PIANIST_SPEAKER,
    conversationId: "marshalls-beach-pianist",
    anchor: host.anchor,
    worldOffset: { x: 0, y: 0.45, z: 0 },
    createProvider: () =>
      new DialogueGraphProvider({
        speaker: BEACH_PIANIST_SPEAKER,
        entry: "offer",
        nodes: [
          {
            id: "offer",
            text: "Do you want to hear a song?",
            choices: [
              { id: "yes", label: "Yes.", action: "play", to: null },
              { id: "not-now", label: "Not right now.", to: null }
            ]
          }
        ]
      }),
    promptLabel: "Talk to the pianist",
    available: () => host.group.visible && host.awaitingRequest(),
    ui: {
      className: "projected-dialogue--beach-pianist",
      defaultTopic: "Marshall's Beach"
    },
    onAction: (action) => {
      if (action === "play") host.requestPerformance();
    }
  });
}

import * as THREE from "three/webgpu";
import { NpcConversation } from "../../gameplay/agents/conversation";
import { DialogueGraphProvider, type DialogueSpeaker } from "../../gameplay/agents/dialogue";
import { SONGS } from "./songs";

export const BEACH_PIANIST_SPEAKER: DialogueSpeaker = {
  id: "marshalls-beach-pianist",
  name: "Pianist",
  title: "Marshall's Beach"
};

export type BeachPianistConversationHost = {
  readonly group: THREE.Object3D;
  readonly anchor: THREE.Object3D;
  readonly awaitingRequest: () => boolean;
  readonly requestPerformance: (songIndex: number) => boolean;
};

/** The pianist asks for a song every time. The first reply is the default/new
 * recording; arrowing down reaches the original. Confirming either starts one
 * performance and closes the card so it gets out of the way of the music. */
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
            text: "Which song would you like to hear?",
            choices: [
              ...SONGS.map((song, songIndex) => ({
                id: song.id,
                label: song.choiceLabel,
                action: `play:${songIndex}`,
                to: null
              })),
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
      if (!action.startsWith("play:")) return;
      const songIndex = Number.parseInt(action.slice(5), 10);
      if (Number.isInteger(songIndex)) host.requestPerformance(songIndex);
    }
  });
}

import * as THREE from "three/webgpu";
import { NpcConversation } from "../agents/conversation";
import { DialogueGraphProvider, type DialogueSpeaker } from "../agents/dialogue";
import type { BuskerTrioApi } from "./index";

/**
 * The summit conversation for the Corona Heights busker trio — the pilot of
 * the shared NPC dialogue system (gameplay/agents/conversation.ts). Wren, the
 * handpan player, fronts the band: walk up while they're chilling on the rock,
 * press E, and she offers a song. Saying yes fires the `play` action, which
 * starts the trio's count-in while her reply names the tune about to play.
 *
 * All Corona-specific personality lives here — the dialogue graph and the
 * `projected-dialogue--corona-buskers` dusk theme. The mechanics are entirely
 * the shared controller's.
 */

export const BUSKER_SPEAKER: DialogueSpeaker = {
  id: "corona-buskers-wren",
  name: "Wren",
  title: "Handpan · Fog Line Trio"
};

/** What the conversation needs from the trio (satisfied by BuskersSystem,
 * whose facade stays stable across HMR swaps of the trio behind it). */
export type BuskerConversationHost = Pick<
  BuskerTrioApi,
  "group" | "songName" | "awaitingRequest" | "requestPerformance" | "seatWorld"
>;

export type BuskerConversationOptions = {
  /** Overlay host for the projected UI. Defaults inside ProjectedDialogueUI. */
  readonly dialogueParent?: HTMLElement;
};

// Above the handpanist's head (seatWorld already returns chest height).
const ANCHOR_OFFSET = { x: 0, y: 0.62, z: 0 };

const FIRST_GREETING =
  "Oh — hey, you made the climb! We're Fog Line. We come up here to write " +
  "when the city gets too loud. Something we can play for you?";

const RETURN_GREETINGS = [
  "Back again! The wind's been humming all evening. Want another one?",
  "Hey, it's you. We were just arguing about which tune is next — settle it for us?",
  "Good timing — Etta just retuned. In the mood for a song?"
];

export function createBuskerConversation(
  host: BuskerConversationHost,
  options: BuskerConversationOptions = {}
): NpcConversation {
  const anchorPoint = new THREE.Vector3();
  let visits = 0;

  const greeting = () =>
    visits === 0 ? FIRST_GREETING : RETURN_GREETINGS[(visits - 1) % RETURN_GREETINGS.length];

  const createProvider = () =>
    new DialogueGraphProvider({
      speaker: BUSKER_SPEAKER,
      entry: "greet",
      nodes: [
        {
          id: "greet",
          text: greeting,
          choices: [
            { id: "yes", label: "I'd love to hear a song.", action: "play", to: "play" },
            { id: "later", label: "Just taking in the view.", to: "later" }
          ]
        },
        {
          id: "play",
          // Resolved after the `play` action fires, so the title below is the
          // song the count-in is already ticking toward.
          text: () =>
            `You got it. This one's called “${host.songName}” — we wrote it up here one foggy night. Stay as long as you like.`,
          metadata: { nextHint: "Enter · Enjoy the show" }
        },
        {
          id: "later",
          text: "Can't blame you — best bench in the city. We'll be here if you change your mind."
        }
      ]
    });

  return new NpcConversation({
    speaker: BUSKER_SPEAKER,
    conversationId: "corona-heights-buskers",
    anchor: () => host.seatWorld("handpan", anchorPoint),
    worldOffset: ANCHOR_OFFSET,
    createProvider,
    promptLabel: () => (visits === 0 ? "Say hi to the buskers" : "Talk to Wren"),
    // No prompt mid-performance — they're playing; let the song be the answer.
    available: () => host.group.visible && host.awaitingRequest,
    ui: {
      className: "projected-dialogue--corona-buskers",
      defaultTopic: "Corona Heights Summit",
      parent: options.dialogueParent
    },
    onAction: (action) => {
      if (action === "play") host.requestPerformance();
    },
    onEnd: (reason) => {
      if (reason === "finished") visits += 1;
    }
  });
}

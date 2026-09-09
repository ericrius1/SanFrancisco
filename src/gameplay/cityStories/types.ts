import type { DialogueSpeaker } from '../agents/dialogue';

/** Stable authored identity; narrative revisions never change a resident's id. */
export interface ResidentStory {
  readonly id: string;
  readonly speaker: DialogueSpeaker;
  readonly activity: 'watch' | 'chat' | 'read' | 'stretch';
  readonly seed: string;
  readonly greeting: string;
  readonly returnGreeting: string;
  readonly everyday: { readonly question: string; readonly text: string };
  readonly reflection: { readonly question: string; readonly text: string };
  readonly connection: {
    readonly residentId: string;
    readonly name: string;
    readonly place: string;
    readonly thread: string;
    readonly question: string;
    readonly unheard: string;
    readonly heard: string;
  };
  readonly farewell: string;
}

/** A chapter is a replaceable snapshot of this place's lives, not a quest script. */
export interface StoryChapter {
  readonly id: string;
  readonly revision: number;
  readonly residents: readonly ResidentStory[];
}

export interface StoryPlace {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** Explicit pedestrian positions; never scatter residents through obstacles. */
  readonly spots: readonly { x: number; z: number; yaw: number }[];
  /** Authored interior floor; otherwise sample the live terrain/bridge. */
  readonly groundY?: number;
  readonly load: () => Promise<{ default: StoryChapter }>;
}

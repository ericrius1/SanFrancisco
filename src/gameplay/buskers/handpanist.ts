import { buildRig } from "../../player/rig";
import type { Musician, MusicianBuilder } from "./types";

// STUB — placeholder so the app boots while the real handpanist lands.
// Seated figure, no instrument, no audio.
export const buildHandpanist: MusicianBuilder = (_audio, _part): Musician => {
  const rig = buildRig({ skin: 5, hair: "long", hat: "none", outfit: "tee", color: 6, accent: 3 });
  rig.group.position.y = 0.11;
  rig.legL.rotation.x = 1.32;
  rig.legR.rotation.x = 1.32;
  rig.shinL.rotation.x = -1.28;
  rig.shinR.rotation.x = -1.28;
  rig.foreL.rotation.x = 0.6;
  rig.foreR.rotation.x = 0.6;
  return {
    group: rig.group,
    update(_dt, clock) {
      rig.torso.rotation.x = 0.04 + Math.sin(clock.phaseTime * 1.7 + 2) * 0.02;
    },
    schedule() {},
    dispose() {
      rig.group.parent?.remove(rig.group);
    }
  };
};

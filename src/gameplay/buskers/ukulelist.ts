import { buildRig } from "../../player/rig";
import type { Musician, MusicianBuilder } from "./types";

// STUB — placeholder so the app boots while the real ukulelist lands.
// Seated figure, no instrument, no audio.
export const buildUkulelist: MusicianBuilder = (_audio, _part): Musician => {
  const rig = buildRig({ skin: 0, hair: "short", hat: "none", outfit: "tee", color: 3, accent: 1 });
  rig.avatar.materials.hair.color.set(0xd68c3a);
  rig.group.position.y = 0.11;
  rig.legL.rotation.x = 1.3;
  rig.legR.rotation.x = 1.38;
  rig.shinL.rotation.x = -1.25;
  rig.shinR.rotation.x = -1.32;
  rig.foreL.rotation.x = 0.5;
  rig.foreR.rotation.x = 0.5;
  return {
    group: rig.group,
    update(_dt, clock) {
      rig.torso.rotation.x = 0.05 + Math.sin(clock.phaseTime * 1.5 + 1) * 0.02;
    },
    schedule() {},
    dispose() {
      rig.group.parent?.remove(rig.group);
    }
  };
};

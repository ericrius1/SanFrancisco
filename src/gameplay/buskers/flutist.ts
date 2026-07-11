import { buildRig } from "../../player/rig";
import type { Musician, MusicianBuilder } from "./types";

// STUB — placeholder so the app boots while the real flutist lands.
// Seated figure, no instrument, no audio.
export const buildFlutist: MusicianBuilder = (_audio, _part): Musician => {
  const rig = buildRig({ skin: 1, hair: "short", hat: "none", outfit: "hoodie", color: 5, accent: 7 });
  rig.group.position.y = 0.11;
  rig.legL.rotation.x = 1.35;
  rig.legR.rotation.x = 1.3;
  rig.shinL.rotation.x = -1.3;
  rig.shinR.rotation.x = -1.25;
  rig.foreL.rotation.x = 0.5;
  rig.foreR.rotation.x = 0.5;
  return {
    group: rig.group,
    update(_dt, clock) {
      rig.torso.rotation.x = 0.05 + Math.sin(clock.phaseTime * 1.6) * 0.02;
    },
    schedule() {},
    dispose() {
      rig.group.parent?.remove(rig.group);
    }
  };
};

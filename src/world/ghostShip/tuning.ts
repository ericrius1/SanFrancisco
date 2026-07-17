import { tunables } from "../../core/persist";

export const GHOST_SHIP_TUNING = tunables("ghostShip", {
  fairyBrightness: { v: 2.2, min: 0.2, max: 5, step: 0.05, label: "fairy-light brightness" },
  waterEnabled: { v: true, label: "hot-tub fluid simulation" },
  waterDistance: { v: 180, min: 40, max: 420, step: 10, label: "fluid wake distance" },
  waterWaveSpeed: { v: 5.4, min: 1, max: 12, step: 0.1, label: "water pressure" },
  waterDamping: { v: 1.25, min: 0.1, max: 4, step: 0.05, label: "water damping" },
  steamAmount: { v: 0.72, min: 0, max: 1.5, step: 0.01, label: "steam amount" },
  showerAmount: { v: 1, min: 0, max: 2.5, step: 0.05, label: "rainbow shower amount" }
});

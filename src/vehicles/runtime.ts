import type { PlayerMode } from "../player/types";
export type VehicleMode = Exclude<PlayerMode, "walk">;
export type VehicleModules = {
  drive: typeof import("./car"); scooter: typeof import("./scooter");
  plane: typeof import("./plane"); boat: typeof import("./boat"); speedboat: typeof import("./boat");
  drone: typeof import("./drone"); board: typeof import("./board");
  skate: typeof import("./skate"); surf: typeof import("./surf"); bird: typeof import("./bird");
};
const factories = {
  drive: () => import("./car"), scooter: () => import("./scooter"), plane: () => import("./plane"),
  boat: () => import("./boat"), speedboat: () => import("./boat"), drone: () => import("./drone"),
  board: () => import("./board"), skate: () => import("./skate"), surf: () => import("./surf"), bird: () => import("./bird")
};
const loaded: Partial<VehicleModules> = {};
const pending = new Map<VehicleMode, Promise<unknown>>();
const activated = new Set<VehicleMode>();
export async function loadVehicleRuntime<M extends VehicleMode>(mode: M): Promise<VehicleModules[M]> {
  if (loaded[mode]) return loaded[mode]!;
  let promise = pending.get(mode);
  if (!promise) {
    promise = factories[mode]().then(module => {
      Object.assign(loaded, { [mode]: module });
      if (mode === "boat" || mode === "speedboat") Object.assign(loaded, { boat: module, speedboat: module });
      return module;
    }).finally(() => pending.delete(mode));
    pending.set(mode, promise);
  }
  return promise as Promise<VehicleModules[M]>;
}
export function vehicleRuntime<M extends VehicleMode>(mode: M): VehicleModules[M] {
  const module = loaded[mode];
  if (!module) throw new Error(`Prepare ${mode} before using its vehicle runtime`);
  return module;
}
export function activateVehicleRuntime(mode: VehicleMode): void { activated.add(mode); }
export function vehicleRuntimeActivated(mode: PlayerMode): boolean { return mode === "walk" || activated.has(mode); }
export function vehicleRuntimeStats() { return { loaded: Object.keys(loaded), activated: [...activated], pending: [...pending.keys()] }; }

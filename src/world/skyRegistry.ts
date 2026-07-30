// Thin DI boundary so high-fragment materials (grass, flowers) can take the
// cheap sky atmosphere path without importing the full Sky module into every
// placement/compile graph. Sky registers once at boot; groundcover reads
// optionally so headless placement probes still construct materials.

export type SkyAtmosphere = {
  /** Hemispheric-mean env radiance (uniform). Replaces analytic SkyEnvNode. */
  grassEnvNode(): unknown;
  /**
   * Install a distance-haze fog on this material, skipping the marine-layer
   * dual tri-noise graph that otherwise lands in every blade fragment.
   */
  installGrassFog(material: { fog: boolean; setupFog: (...args: any[]) => any }): void;
};

let skyAtmosphere: SkyAtmosphere | null = null;

export function registerSkyAtmosphere(value: SkyAtmosphere): void {
  skyAtmosphere = value;
}

export function optionalSkyAtmosphere(): SkyAtmosphere | null {
  return skyAtmosphere;
}

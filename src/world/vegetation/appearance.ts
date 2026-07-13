// Sandbox-owned vegetation appearance state. Tree materials still built by the
// transitional SeedThree adapter read this same uniform until the in-repo
// foliage material replaces them.

import { uniform } from "three/tsl";

/** Global tree-canopy albedo multiplier in linear space. */
export const foliageBrightness = uniform(1);

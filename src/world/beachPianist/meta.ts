/**
 * Lightweight first-approach/minimap metadata for the lazy Beach Pianist site.
 * Kept in its own module so main.ts's optional-site scheduler and the minimap
 * can import the coordinates without pulling in the site's code chunk.
 *
 * The pad was chosen by probing map.groundTop across the Marshall's-Beach
 * shore strip below the Presidio bluffs: the flattest dry sand near the
 * waterline (probe: spread 0.10 m over the pad, groundTop +1.8 m, water 10 m
 * seaward, unobstructed line to the deck). The Golden Gate's south anchorage
 * deck begins ~780 m NNE, so the bridge looms large across the upper frame.
 * `yaw` turns the assembly so the keyboard line/side profile faces the SSW
 * arrival camera with the bridge spanning directly behind the pianist.
 */
export const BEACH_PIANIST_SITE = {
  x: -3340,
  z: -870,
  yaw: -1.6
} as const;

export const BEACH_PIANIST_CENTER = { x: BEACH_PIANIST_SITE.x, z: BEACH_PIANIST_SITE.z } as const;

/**
 * Where the framing looks: a point on the Golden Gate deck near the south
 * tower. The arrival spawn sits on the line through this point and the site
 * (on the far side), so the player arrives with spawn → pianist → bridge
 * collinear and the deck spanning directly behind the performance.
 */
export const BEACH_PIANIST_BRIDGE_AIM = { x: -2947, z: -2289 } as const;

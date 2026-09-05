/** A quality change needs continuous pressure, not merely an old last-change
 * timestamp. A long idle session must not downscale on its first isolated hitch. */
export function createQualityDwell() {
  let direction = 0;
  let since = 0;
  return {
    reset() { direction = 0; since = 0; },
    ready(next: -1 | 0 | 1, now: number, duration: number): boolean {
      if (next !== direction || next === 0) { direction = next; since = now; }
      return next !== 0 && now - since >= duration;
    }
  };
}

export const HANG_GLIDER_PALETTES = [
  {
    id: "pacific",
    label: "Pacific",
    colors: [0xeaf7ef, 0x47b9aa, 0xf0c45c] as const
  },
  {
    id: "sunset",
    label: "Sunset",
    colors: [0xffedc8, 0xe75c4d, 0xf3b94e] as const
  },
  {
    id: "aurora",
    label: "Aurora",
    colors: [0xdffdf3, 0x4169b5, 0xbd65c8] as const
  },
  {
    id: "midnight",
    label: "Midnight",
    colors: [0xbfe7ed, 0x183c5c, 0x57e0c0] as const
  }
] as const;

export const HANG_GLIDER_FRAMES = [
  { id: "graphite", label: "Graphite", color: 0x202a31, accent: 0x8e9da4, metalness: 0.72 },
  { id: "alloy", label: "Alloy", color: 0xc6d2d3, accent: 0x657981, metalness: 0.9 },
  { id: "copper", label: "Copper", color: 0xa9633e, accent: 0xe2b56a, metalness: 0.82 }
] as const;

export type HangGliderPaletteId = (typeof HANG_GLIDER_PALETTES)[number]["id"];
export type HangGliderFrameId = (typeof HANG_GLIDER_FRAMES)[number]["id"];

export type HangGliderStyle = Readonly<{
  palette: HangGliderPaletteId;
  frame: HangGliderFrameId;
  span: number;
  crown: number;
  billow: number;
  flutter: number;
  wind: number;
}>;

export type HangGliderSliderKey = Exclude<keyof HangGliderStyle, "palette" | "frame">;

/** Defaults and UI metadata deliberately live together: changing a range or
 * default invalidates the stored signature instead of growing migration code. */
export const HANG_GLIDER_SLIDERS: readonly Readonly<{
  key: HangGliderSliderKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
}>[] = [
  { key: "span", label: "Span", hint: "compact · soaring", min: 0.88, max: 1.18, step: 0.01, value: 1 },
  { key: "crown", label: "Crown", hint: "flat · arced", min: 0.72, max: 1.38, step: 0.01, value: 1 },
  { key: "billow", label: "Billow", hint: "taut · full", min: 0.2, max: 1.55, step: 0.01, value: 1.08 },
  { key: "flutter", label: "Leech", hint: "calm · dancing", min: 0.1, max: 1.65, step: 0.01, value: 0.82 },
  { key: "wind", label: "Tempo", hint: "drift · lively", min: 0.45, max: 1.8, step: 0.01, value: 1 }
] as const;

export const DEFAULT_HANG_GLIDER_STYLE: HangGliderStyle = Object.freeze({
  palette: "pacific",
  frame: "graphite",
  ...Object.fromEntries(HANG_GLIDER_SLIDERS.map(({ key, value }) => [key, value]))
} as HangGliderStyle);

const STORAGE_KEY = "sf.hang-glider-style";
const STORAGE_SCHEMA = JSON.stringify({
  defaults: DEFAULT_HANG_GLIDER_STYLE,
  sliders: HANG_GLIDER_SLIDERS.map(({ key, min, max, step }) => ({ key, min, max, step })),
  palettes: HANG_GLIDER_PALETTES.map(({ id }) => id),
  frames: HANG_GLIDER_FRAMES.map(({ id }) => id)
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function normalizeHangGliderStyle(value: Partial<HangGliderStyle> | null | undefined): HangGliderStyle {
  const source = value ?? DEFAULT_HANG_GLIDER_STYLE;
  const sliders = Object.fromEntries(HANG_GLIDER_SLIDERS.map((spec) => {
    const raw = source[spec.key];
    const numeric = typeof raw === "number" && Number.isFinite(raw) ? raw : spec.value;
    return [spec.key, clamp(numeric, spec.min, spec.max)];
  })) as Pick<HangGliderStyle, HangGliderSliderKey>;
  return {
    palette: HANG_GLIDER_PALETTES.some(({ id }) => id === source.palette)
      ? source.palette as HangGliderPaletteId
      : DEFAULT_HANG_GLIDER_STYLE.palette,
    frame: HANG_GLIDER_FRAMES.some(({ id }) => id === source.frame)
      ? source.frame as HangGliderFrameId
      : DEFAULT_HANG_GLIDER_STYLE.frame,
    ...sliders
  };
}

export function loadHangGliderStyle(): HangGliderStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_HANG_GLIDER_STYLE;
    const stored = JSON.parse(raw) as { schema?: unknown; style?: Partial<HangGliderStyle> };
    if (stored.schema !== STORAGE_SCHEMA) {
      localStorage.removeItem(STORAGE_KEY);
      return DEFAULT_HANG_GLIDER_STYLE;
    }
    return normalizeHangGliderStyle(stored.style);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return DEFAULT_HANG_GLIDER_STYLE;
  }
}

export function saveHangGliderStyle(style: HangGliderStyle): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    schema: STORAGE_SCHEMA,
    style: normalizeHangGliderStyle(style)
  }));
}

export function hangGliderPalette(id: HangGliderPaletteId) {
  return HANG_GLIDER_PALETTES.find((entry) => entry.id === id) ?? HANG_GLIDER_PALETTES[0];
}

export function hangGliderFrame(id: HangGliderFrameId) {
  return HANG_GLIDER_FRAMES.find((entry) => entry.id === id) ?? HANG_GLIDER_FRAMES[0];
}

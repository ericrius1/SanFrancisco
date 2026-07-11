// Lightweight boot phase timing. bootMark(label) stamps performance.now() at
// each meaningful boot step; bootMarkSummary() renders a one-line breakdown of
// the deltas between them. Near-zero cost (a push per phase), always on — the
// summary line is how "where did boot go" gets answered without attaching a
// profiler. The last few boots persist so a regression shows up as a shifted
// phase, not a vibe.

type Mark = { label: string; t: number };

const marks: Mark[] = [];
let t0 = 0;

/** Call once at the very top of boot(); resets the timeline. */
export function bootMarkStart() {
  t0 = performance.now();
  marks.length = 0;
  marks.push({ label: "start", t: t0 });
}

export function bootMark(label: string) {
  marks.push({ label, t: performance.now() });
}

/** "map 512 · gpu 890 · tiles 1240 · physics 410 · world 220 · warmup 1180 = 4.5s"
 *  — each number is the delta FROM THE PREVIOUS mark (ms), so the fat phase is
 *  obvious at a glance; the tail is total seconds since start. */
export function bootMarkSummary(): string {
  if (marks.length < 2) return "(no marks)";
  const parts: string[] = [];
  for (let i = 1; i < marks.length; i++) {
    parts.push(`${marks[i].label} ${Math.round(marks[i].t - marks[i - 1].t)}`);
  }
  const total = (marks[marks.length - 1].t - marks[0].t) / 1000;
  return `${parts.join(" · ")} = ${total.toFixed(1)}s`;
}

const HISTORY_KEY = "sf-boot-history-v1";

/** Append this boot's phase breakdown to a rolling last-5 history in
 *  localStorage, so a slow boot can be compared against recent good ones. */
export function persistBootHistory() {
  try {
    const phases: Record<string, number> = {};
    for (let i = 1; i < marks.length; i++) {
      phases[marks[i].label] = Math.round(marks[i].t - marks[i - 1].t);
    }
    const raw = localStorage.getItem(HISTORY_KEY);
    const hist = raw ? (JSON.parse(raw) as unknown[]) : [];
    hist.push({ total: Math.round(marks[marks.length - 1].t - marks[0].t), phases });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(-5)));
  } catch {
    // localStorage unavailable / quota / private mode — timing is best-effort.
  }
}

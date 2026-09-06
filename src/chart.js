// The memory trend's axis maths, shared by the pane's grid and the status-bar
// tooltip's chart so the two can never disagree about what "high" means.
//
// Pure: give it the history and how many columns you have room for, get back
// one 0..1 value per column plus the range it fitted them to.

/** How much history the chart shows. */
export const CHART_MS = 3 * 60_000;
/** Columns in the status-bar tooltip's chart. The host draws at most 48. */
export const TIP_COLS = 40;

/**
 * Bucket the history into `cols` columns.
 *
 * Each column holds the PEAK of its slice of time - a monitor that hides a
 * spike between two samples is not doing its job - step-held across slices that
 * caught no sample (the pane falls back to a slower cadence, and memory does
 * not teleport). Columns before the first sample stay 0, which the renderers
 * draw as an empty column rather than as a floor value.
 *
 * The axis fits the window instead of starting at zero: against 32 GB of
 * installed RAM every real change is a flat line. A trace that is genuinely
 * steady is held to a 2% band so noise is not magnified into a mountain range,
 * and both ends are returned so the caller can label the range it is looking at.
 *
 * @param {{ t: number, rss: number }[]} history newest last
 * @param {number} cols
 * @param {number} [now]
 * @returns {{ values: number[], lo: number, hi: number }} `values` is empty
 *   when there is not enough history to draw anything yet.
 */
export function pixelSeries(history, cols, now = Date.now()) {
  const t0 = now - CHART_MS;
  const pts = history.filter((p) => p.t >= t0);
  if (pts.length < 2 || cols < 1) return { values: [], lo: 0, hi: 0 };

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.rss < lo) lo = p.rss;
    if (p.rss > hi) hi = p.rss;
  }
  const band = Math.max(hi - lo, hi * 0.02, 1);
  const top = hi + band * 0.15;
  const bottom = Math.max(0, lo - band * 0.15);

  /** @type {number[]} */
  const peak = new Array(cols).fill(-1);
  for (const p of pts) {
    const c = Math.min(cols - 1, Math.floor(((p.t - t0) / CHART_MS) * cols));
    if (c >= 0 && p.rss > peak[c]) peak[c] = p.rss;
  }
  /** @type {number[]} */
  const values = new Array(cols).fill(0);
  let held = -1;
  for (let c = 0; c < cols; c++) {
    if (peak[c] >= 0) held = peak[c];
    else if (held >= 0) peak[c] = held;
    if (peak[c] >= 0) values[c] = (peak[c] - bottom) / (top - bottom);
  }
  return { values, lo, hi };
}

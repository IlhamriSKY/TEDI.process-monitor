// Shared runtime state for the Process Monitor. esbuild preserves ESM live
// bindings across the bundle, so every other module reads `ctx`/`state` live
// and mutates through the setters here (same shape as tedi.ai-usage). Keep
// this the ONE owner of the state so no module keeps a second copy.

/** @typedef {import("../tedi").ExtensionContext} ExtensionContext */
/** @typedef {import("./procs.js").Snapshot} Snapshot */

/** @type {ExtensionContext | null} */
export let ctx = null;

/** @param {ExtensionContext | null} value */
export function setCtx(value) {
  ctx = value;
}

/**
 * Previous CPU sample, keyed by pid. Cumulative CPU time only becomes a
 * percentage against an earlier reading, so the first poll after activation
 * shows memory but no CPU.
 * @typedef {{ at: number, cpu: Map<number, { cpuUs: number, startMs: number }> }} CpuSample
 */

export const state = {
  /** Latched false on deactivate so late async work becomes a no-op. */
  active: false,
  /** Poll interval handle. @type {ReturnType<typeof setInterval> | null} */
  timer: null,
  /** Interval the timer is currently armed at, so we only re-arm on a change. */
  timerMs: 0,
  /** True while a sample is in flight; a second tick is dropped rather than
   *  queued, because the sampler costs ~400 ms and overlapping runs would
   *  compute a CPU delta against a window that is already stale. */
  sampling: false,
  /** @type {CpuSample | null} */
  prev: null,
  /** Previous LIGHT block (pid -> memory + CPU time) and when it was taken, for
   *  the per-second CPU delta while the stream is running.
   *  @type {Map<number, { rss: number, cpuUs: number }> | null} */
  prevLight: null,
  prevLightAt: 0,
  /**
   * Memory over time, for the chart: newest last, trimmed to `HISTORY_MS`.
   * Lives here rather than in the pane so closing and reopening the pane does
   * not throw the trend away.
   * @type {{ t: number, rss: number }[]}
   */
  history: [],
  /** The live sampler, when one is running. See `stream.js`.
   *  @type {{ handle: number, offset: number, tail: string,
   *           timer: ReturnType<typeof setInterval> | null,
   *           onBlock: (kind: "F" | "L", payload: string) => void } | null} */
  stream: null,
  /** Latched once the stream has failed, so we stop trying to start one and
   *  keep the one-shot poll instead. */
  streamDead: false,
  /** Last good snapshot, so a newly opened pane paints immediately instead of
   *  waiting out the poll. @type {Snapshot | null} */
  last: null,
  /** Why the last sample failed, shown in the pane. @type {string | null} */
  error: null,
  /** Live pane/tab mounts. Each entry re-renders on every snapshot; a mounted
   *  pane also speeds the poll up. @type {Set<() => void>} */
  views: new Set(),
  /** Set by activate(): what the status item and the command run. Lives here
   *  rather than being imported from index.js so statusbar.js and panel.js do
   *  not close an import cycle. @type {(() => void) | null} */
  onOpen: null,
  /** Same, for "sample right now". @type {(() => void) | null} */
  onRefresh: null,
  /** Called when the set of open panes changes, so the sampler can be started
   *  or - more importantly - stopped the moment the last pane closes rather
   *  than at the next timer tick. @type {(() => void) | null} */
  onArm: null,
};

export function clearTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    state.timerMs = 0;
  }
}

// Process Monitor - a task manager scoped to TEDI.
//
// One status-bar meter (total memory of everything TEDI owns, plus a live CPU
// figure in its tooltip) and one pane holding a memory chart and the whole
// process tree: the window, the WebView2 renderer, the PTY daemon, every
// terminal shell and everything those shells started - which is where an
// attached Claude Code or Codex shows up, badged as an agent.
//
// Two sampling modes, because the cost of reading the process table is all in
// the process you spawn to read it:
//   - pane open  -> a live sampler (`stream.js`), one block a second from one
//                   long-lived shell, ~6% of a core;
//   - meter only -> a one-shot every 30 s, and nothing at all while the window
//                   is hidden.
// The one-shot also stands in whenever the sampler cannot run, so nothing here
// depends on it. Nothing is killed, written or sent anywhere - only read.

/** @typedef {import("../tedi").ExtensionContext} ExtensionContext */

import { ctx, setCtx, state, clearTimer } from "./runtime.js";
import {
  sample,
  cpuSampleOf,
  buildSnapshot,
  applyLight,
  parseLight,
  parseWindows,
  parseUnix,
  dropSelf,
  readTotalMemory,
} from "./procs.js";
import { render, removeItem } from "./statusbar.js";
import { mount, repaintViews, removeStyles } from "./panel.js";
import { CHART_MS } from "./chart.js";
import * as stream from "./stream.js";

const PANEL_ID = "processes";
const CMD_OPEN = "tedi.process-monitor.open";

/** Poll cadence with no pane open: the meter is a glance, not a graph. */
const IDLE_MS = 30_000;
/** ...and with a pane open but no live sampler to feed it. A one-shot costs
 *  ~600 ms of a core on Windows before it reads a single row, so this is as
 *  fast as the fallback can be without becoming the thing it measures. */
const OPEN_MS = 5_000;
/** The live sampler is presumed wedged if nothing arrives in this long, and
 *  the one-shot takes over. */
const STREAM_STALE_MS = 15_000;

/** Physical RAM, resolved once at activation. 0 = unknown, which drops the bar. */
let totalMem = 0;

/** @param {ExtensionContext} context */
export async function activate(context) {
  setCtx(context);
  state.active = true;

  const missing = checkRequiredApis(context);
  if (missing.length > 0) {
    context.logger?.warn?.(`Process Monitor needs a newer TEDI (missing: ${missing.join(", ")}).`);
    return;
  }

  state.onOpen = openPane;
  state.onRefresh = refreshNow;
  state.onArm = () => void arm();

  context.registerCommandHandler(CMD_OPEN, openPane);
  context.addDisposer(context.registerPanelRenderer(PANEL_ID, (container) => mount(container)));

  // A hidden window is a window nobody is reading: drop the live sampler while
  // it is away rather than paying for a chart no one can see.
  const onVisibility = () => void arm();
  document.addEventListener("visibilitychange", onVisibility);
  context.addDisposer(() => document.removeEventListener("visibilitychange", onVisibility));

  // Seed the meter before the first sample lands, so the icon appears at once
  // and says what it is doing.
  render(null, 0);

  totalMem = await readTotalMemory(isWindows());
  if (!state.active) return;
  await poll();
  await arm();
}

export async function deactivate() {
  state.active = false;
  clearTimer();
  await stream.stop();
  state.views.clear();
  removeItem();
  removeStyles();
  state.last = null;
  state.prev = null;
  state.prevLight = null;
  state.history = [];
  state.error = null;
  state.streamDead = false;
  state.onOpen = null;
  state.onRefresh = null;
  state.onArm = null;
  setCtx(null);
}

/** Open (or focus) the tree. A pane is preferred over a tab: it is the same
 *  frame as a terminal, so split, join and close all come free. */
function openPane() {
  const opts = {
    panelId: PANEL_ID,
    title: "Processes",
    icon: "lucide:Activity",
    reuseKey: "main",
  };
  try {
    if (typeof ctx?.tabs?.openExtensionPane === "function") ctx.tabs.openExtensionPane(opts);
    else ctx?.tabs?.openExtensionTab?.(opts);
  } catch (err) {
    ctx?.logger?.error?.("open failed", err);
  }
}

/** Sample now, from the Refresh button or a freshly mounted pane. */
function refreshNow() {
  void poll().then(arm);
}

/**
 * Bring the sampling mode in line with what is on screen: a live sampler while
 * a visible pane wants one, a one-shot timer otherwise. Called after every
 * poll and on every visibility change, so opening or closing a pane settles
 * within one tick.
 */
let arming = false;
let armAgain = false;
async function arm() {
  // Spawning a shell is not instant, and the timer, the visibility listener and
  // a closing pane can all ask for a change while one is in flight. Serialise
  // them, and re-run once at the end so the last request wins - otherwise a
  // pane closed during a start would leave a PowerShell running with nothing
  // reading it.
  if (arming) {
    armAgain = true;
    return;
  }
  arming = true;
  try {
    do {
      armAgain = false;
      await armOnce();
    } while (armAgain && state.active);
  } finally {
    arming = false;
  }
}

async function armOnce() {
  if (!state.active) return;
  const wantStream = state.views.size > 0 && !document.hidden && !state.streamDead;
  if (wantStream && !state.stream) {
    if (!(await stream.start(isWindows(), onBlock))) state.streamDead = true;
  } else if (!wantStream && state.stream) {
    await stream.stop();
  }
  if (!state.active) return;
  // While the sampler runs, the timer is only its watchdog (see `poll`).
  const want = state.stream || state.views.size === 0 ? IDLE_MS : OPEN_MS;
  if (state.timer && state.timerMs === want) return;
  clearTimer();
  state.timerMs = want;
  state.timer = setInterval(() => void poll().then(arm), want);
}

/** One block from the live sampler. `F` rebuilds the tree, `L` refreshes the
 *  numbers on the tree the last `F` built.
 *  @param {"F" | "L"} kind @param {string} payload */
function onBlock(kind, payload) {
  if (!state.active) return;
  const at = Date.now();
  const ncpu = navigator.hardwareConcurrency || 1;
  if (kind === "F") {
    const rows = dropSelf(isWindows() ? parseWindows(payload) : parseUnix(payload));
    state.last = buildSnapshot(rows, state.prev, at, ncpu);
    state.prev = cpuSampleOf(rows, at);
    // Seed the light baseline from the full block so the very next light block
    // already has a CPU delta to work from.
    state.prevLight = new Map(rows.map((r) => [r.pid, { rss: r.rss, cpuUs: r.cpuUs }]));
    state.prevLightAt = at;
  } else {
    if (!state.last) return; // numbers with no tree to put them on
    const light = parseLight(payload, isWindows());
    state.last = applyLight(state.last, light, state.prevLight, at, at - state.prevLightAt, ncpu);
    state.prevLight = light;
    state.prevLightAt = at;
  }
  state.error = null;
  commit();
}

async function poll() {
  if (!state.active || state.sampling) return;
  // Minimised or occluded: nobody is reading the meter, and the sample is the
  // most expensive thing this extension does. The next tick picks it up.
  // Never skips the FIRST sample, so a webview that reports itself hidden when
  // it is not degrades to a stale reading rather than an empty one forever.
  if (document.hidden && state.last) return;
  // The live sampler keeps everything current; this timer is then only its
  // watchdog, and a shell that has gone quiet hands the job back.
  if (state.stream && state.last) {
    if (Date.now() - state.last.at < STREAM_STALE_MS) return;
    state.streamDead = true;
    await stream.stop();
  }
  state.sampling = true;
  const at = Date.now();
  try {
    const rows = await sample(isWindows());
    if (!state.active) return;
    // The webview knows the core count for free; asking the shell for it would
    // be a second process spawn for a number that never changes.
    const ncpu = navigator.hardwareConcurrency || 1;
    state.last = buildSnapshot(rows, state.prev, at, ncpu);
    state.prev = cpuSampleOf(rows, at);
    state.prevLight = new Map(rows.map((r) => [r.pid, { rss: r.rss, cpuUs: r.cpuUs }]));
    state.prevLightAt = at;
    state.error = null;
  } catch (err) {
    // Keep the last good tree rather than blanking: a single failed sample is
    // usually a busy machine, not a changed one.
    state.error = err instanceof Error ? err.message : String(err);
    ctx?.logger?.warn?.("process sample failed", err);
  } finally {
    state.sampling = false;
    if (state.active) commit();
  }
}

/** Record the new total for the chart, then repaint everything that shows it. */
function commit() {
  const snap = state.last;
  if (snap) {
    state.history.push({ t: snap.at, rss: snap.rss });
    const cutoff = snap.at - CHART_MS;
    // The history is append-only in time, so the expired points are a prefix.
    let drop = 0;
    while (drop < state.history.length && state.history[drop].t < cutoff) drop++;
    if (drop > 0) state.history.splice(0, drop);
  }
  render(state.last, totalMem);
  repaintViews();
}

function isWindows() {
  return ctx?.os?.platform === "windows";
}

/** @param {ExtensionContext} c */
function checkRequiredApis(c) {
  const missing = [];
  if (typeof c?.invoke !== "function") missing.push("ctx.invoke");
  if (typeof c?.statusBar?.setItem !== "function") missing.push("ctx.statusBar");
  if (typeof c?.registerPanelRenderer !== "function") missing.push("ctx.registerPanelRenderer");
  if (typeof c?.tabs?.openExtensionTab !== "function") missing.push("ctx.tabs.openExtensionTab");
  return missing;
}

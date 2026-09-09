// The Processes pane: a live memory chart over the whole tree, and under it one
// row for TEDI, one for its PTY daemon, and one for each terminal you opened.
//
// The rows come from `collapse` (procs.js), not from the snapshot directly: the
// snapshot is the full per-pid tree and every process not on that short list is
// SUMMED into the row that owns it. So the pane is short without being a lie -
// the memory column still adds up to the whole tree, and a `+N` on each row
// says how many processes it is speaking for.
//
// Painted as plain DOM with a single `<style>` block; every class is `tpm-`
// prefixed and every colour comes from the host's design tokens, so the pane
// follows the active theme and every preset with no per-theme code. The host
// container is the bento tray (it insets its contents by 6 px and paints the
// deeper --sidebar well), so the card below floats on it the same way the SQL
// and API panes do.
//
// Rows are updated IN PLACE while the process set is unchanged, and only
// rebuilt when it moves. At a one-second cadence a wholesale rebuild would
// throw away the row you are hovering (and its command-line tooltip) every
// second, which makes the pane unreadable exactly when it is most alive.

import { ctx, state } from "./runtime.js";
import { collapse, fmtBytes, fmtPct, ownRss } from "./procs.js";
import { pixelSeries } from "./chart.js";

const STYLE_ID = "tpm-styles";

/** The host's pixel unit: `PixelBar` draws 4 px cells with a 2 px gap
 *  (`h-2.5 w-1` + `gap-[2px]` in the status tooltip). The chart is the same
 *  grid, which is why it is measured in real pixels and never scaled. */
const CELL = 4;
const GAP = 2;
const PITCH = CELL + GAP;
/** Padding inside `.tpm-chart`, mirrored here so the grid can be sized in JS. */
const CHART_PAD_X = 8;
const CHART_PAD_TOP = 22;
const CHART_PAD_BOTTOM = 14;

const CSS = `
.tpm-host { height: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 6px; box-sizing: border-box; background: var(--sidebar, var(--background)); color: var(--foreground); font-size: 11.5px; }
.tpm-card { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; border: 1px solid var(--border); border-radius: var(--radius, 0); background: var(--background); overflow: hidden; }
.tpm-bar { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
.tpm-chips { display: flex; align-items: center; gap: 8px; color: var(--muted-foreground); min-width: 0; overflow: hidden; white-space: nowrap; }
.tpm-chips > span + span::before { content: "·"; margin-right: 8px; opacity: 0.6; }
.tpm-chips > span:first-child { color: var(--foreground); font-weight: 600; }
.tpm-spacer { flex: 1 1 auto; }
.tpm-btn { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--radius, 0); background: var(--tedi-button-face, color-mix(in srgb, var(--foreground) 18%, transparent)); color: var(--tedi-button-face-foreground, var(--foreground)); font: inherit; font-size: 11px; cursor: pointer; outline: none; }
.tpm-btn:hover:not([disabled]) { background: var(--tedi-button-face-hover, color-mix(in srgb, var(--foreground) 28%, transparent)); }
.tpm-btn:focus-visible { border-color: var(--ring, var(--primary)); }

/* --- Chart -------------------------------------------------------------
   A pixel grid, not a plotted line: 4px cells with a 2px gap, the same unit
   PixelBar draws in the status bar and its tooltip, so the meter and the chart
   read as one component. The svg is sized in real pixels by the JS (never
   scaled - a stretched pixel is not a pixel), hence the padding numbers here
   are mirrored in CHART_PAD_*. */
.tpm-chart { position: relative; flex: 0 0 auto; height: 104px; padding: 22px 8px 14px; border-bottom: 1px solid var(--border); box-sizing: border-box; }
.tpm-chart svg { display: block; }
/* PixelBar's empty track is muted-foreground/25, which is tuned for eight cells
   in a status pill. Across a thousand it reads as static, so the same colour is
   taken down to 16%: quiet enough to be a surface, present enough to show the
   grid the lit cells sit on. */
.tpm-px-off { fill: color-mix(in srgb, var(--muted-foreground) 16%, transparent); }
.tpm-px-on { fill: color-mix(in srgb, var(--primary, #3b82f6) 55%, transparent); }
.tpm-px-cap { fill: var(--primary, #3b82f6); }
.tpm-cap { position: absolute; top: 5px; font-size: 10px; color: var(--muted-foreground); pointer-events: none; }
.tpm-cap.is-now { left: 8px; font-size: 13px; font-weight: 600; color: var(--foreground); font-variant-numeric: tabular-nums; line-height: 14px; }
.tpm-cap.is-range { right: 8px; top: 7px; text-align: right; font-variant-numeric: tabular-nums; }
.tpm-cap.is-span { top: auto; bottom: 2px; left: 8px; opacity: 0.75; }
/* The fourth corner. The headline above it is the whole tree, which is mostly
   what the user started inside TEDI; this is the part that is TEDI. It sits on
   the chart rather than in the chip strip because the chart is full width and
   the strip clips. */
.tpm-cap.is-own { top: auto; bottom: 2px; right: 8px; text-align: right; font-variant-numeric: tabular-nums; }

/* --- Table ------------------------------------------------------------- */
.tpm-head, .tpm-row { display: grid; grid-template-columns: minmax(0, 1fr) 60px 52px 60px; align-items: center; gap: 8px; padding: 0 8px; }
.tpm-head { height: 22px; flex: 0 0 auto; border-bottom: 1px solid var(--border); color: var(--muted-foreground); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.tpm-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px 0 6px; }
.tpm-row { height: 21px; }
.tpm-row:hover { background: color-mix(in srgb, var(--muted, #888) 28%, transparent); }
.tpm-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tpm-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tpm-sub { color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tpm-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
.tpm-num.is-hot { color: var(--foreground); }
.tpm-badge { flex: 0 0 auto; padding: 0 5px; border-radius: var(--radius, 0); background: color-mix(in srgb, var(--primary, #3b82f6) 18%, transparent); color: var(--primary, #3b82f6); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; line-height: 15px; }
/* How many processes this row is speaking for. Quieter than the sub: it is a
   footnote on the memory column, not part of the name. */
.tpm-rolled { flex: 0 0 auto; color: var(--muted-foreground); opacity: 0.65; font-variant-numeric: tabular-nums; }
/* The badge, the sub and the count are always in the DOM so a row can gain or
   lose one without being rebuilt; empty ones take no space. */
.tpm-badge:empty, .tpm-sub:empty, .tpm-rolled:empty { display: none; }
.tpm-row[data-role="app"] .tpm-label, .tpm-row[data-role="daemon"] .tpm-label { font-weight: 600; }
.tpm-row[data-role="terminal"] .tpm-label { color: var(--foreground); }
.tpm-note { padding: 16px; color: var(--muted-foreground); line-height: 1.5; }

/* --- Tooltip ----------------------------------------------------------
   Matches the host's own tooltip (src/components/ui/tooltip.tsx): the
   --popover surface, an almost-invisible 1px ring rather than a border, 11px
   text at leading-snug, 12px/6px padding, a soft drop shadow and a 320px cap.
   Corners are square because globals.css force-zeros every border-radius, so
   no radius is declared here either. The alternative was the native title
   attribute, which looks like Windows, not like TEDI.
   (No backticks in this block: it is a JS template literal and one would close
   the string mid-comment.) */
.tpm-tip { position: fixed; z-index: 10001; top: 0; left: 0; max-width: 320px; padding: 6px 12px; background: var(--popover, var(--background)); color: var(--popover-foreground, var(--foreground)); font-size: 11px; line-height: 1.375; box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent), 0 10px 15px -3px rgb(0 0 0 / 0.22), 0 4px 6px -4px rgb(0 0 0 / 0.22); pointer-events: none; opacity: 0; transform: scale(0.95); transform-origin: top center; transition: opacity 0.12s ease, transform 0.12s ease; overflow-wrap: anywhere; }
.tpm-tip.is-open { opacity: 1; transform: scale(1); }
.tpm-tip-title { font-weight: 600; }
.tpm-tip-cmd { color: var(--muted-foreground); font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; margin-top: 3px; white-space: pre-wrap; }
.tpm-tip-more { color: var(--muted-foreground); margin-top: 5px; }
`;

export function injectStyles() {
  // Rewrite rather than bail: an in-place extension UPGRADE re-activates
  // without deactivating, so an early return would leave the OLD stylesheet in
  // the head and the new markup styled by it.
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
}

export function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
  removeTip();
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
//
// One shared bubble for every pane, living on `document.body` so it is never
// clipped by the scroller it belongs to. The numbers are the host's own:
// `TooltipProvider` delays 200 ms, `TooltipContent` offsets 6 px from the
// trigger and keeps 8 px off the viewport edge.

const TIP_DELAY_MS = 200;
const TIP_OFFSET = 6;
const TIP_EDGE = 8;
/** Clearance under the pointer for the flipped case. The cursor's hotspot is
 *  the arrow's TIP, and the glyph hangs down-right from it, so 6 px above the
 *  hotspot is already clear air while 6 px below is still under the arrow. */
const TIP_CURSOR = 20;

/** @type {HTMLElement | null} */
let tipEl = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let tipTimer = null;
/** The row the bubble currently describes, so moving inside one row does not
 *  restart it and moving between rows does not re-wait the delay - the same
 *  "skip delay" feel the host's tooltip provider gives dense icon strips. */
let tipRow = /** @type {HTMLElement | null} */ (null);
/** Where the pointer is. The bubble is anchored to the CURSOR rather than to
 *  the row, because a row is 21 px tall in a list that scrolls: a bubble hung
 *  off the row's box lands over the neighbouring rows and reads as belonging to
 *  one of them. Above the pointer is the one place it never covers what you are
 *  pointing at. */
let tipX = 0;
let tipY = 0;

function tipNode() {
  if (tipEl?.isConnected) return tipEl;
  tipEl = el("div", "tpm-tip");
  tipEl.setAttribute("role", "tooltip");
  document.body.appendChild(tipEl);
  return tipEl;
}

/** @param {HTMLElement} row */
function openTip(row) {
  const tip = tipNode();
  const title = el("div", "tpm-tip-title", row.dataset.tipTitle ?? "");
  tip.replaceChildren(title);
  if (row.dataset.tipCmd) tip.append(el("div", "tpm-tip-cmd", row.dataset.tipCmd));
  // A collapsed row owes the reader an account of what it is standing in for.
  if (row.dataset.tipMore) tip.append(el("div", "tpm-tip-more", row.dataset.tipMore));

  // Measure with the bubble laid out but still invisible, then place it above
  // the pointer, centred on it, flipped below only when there is no room, and
  // clamped horizontally so a cursor at the window's edge cannot push it
  // off-screen.
  tip.classList.add("is-open");
  const t = tip.getBoundingClientRect();
  const maxX = window.innerWidth - t.width - TIP_EDGE;
  const x = Math.max(TIP_EDGE, Math.min(tipX - t.width / 2, Math.max(TIP_EDGE, maxX)));
  let y = tipY - t.height - TIP_OFFSET;
  const above = y >= TIP_EDGE;
  if (!above) y = tipY + TIP_CURSOR;
  tip.style.transformOrigin = above ? "bottom center" : "top center";
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(Math.max(TIP_EDGE, y))}px`;
}

/** Repaint the bubble if it is the one describing this row. A row's numbers and
 *  its rolled-up count move every second under a stationary cursor, and a
 *  tooltip still saying "+10" over a row that now reads "+14" is worse than no
 *  tooltip. Placement is redone with it, because new text is a new size.
 *  @param {HTMLElement} row */
function refreshTip(row) {
  if (tipRow === row && tipEl?.classList.contains("is-open")) openTip(row);
}

function hideTip() {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = null;
  tipRow = null;
  tipEl?.classList.remove("is-open");
}

export function removeTip() {
  hideTip();
  tipEl?.remove();
  tipEl = null;
}

/** Record the pointer for the next `openTip`. Separate from `onHover` because
 *  that one returns early while the pointer stays on one row, and the bubble
 *  still has to open where the pointer ENDED UP after the 200 ms wait.
 *  @param {MouseEvent} ev */
function trackPointer(ev) {
  tipX = ev.clientX;
  tipY = ev.clientY;
}

/** @param {MouseEvent} ev */
function onHover(ev) {
  trackPointer(ev);
  const target = ev.target instanceof Element ? ev.target.closest(".tpm-row") : null;
  const row = target instanceof HTMLElement ? target : null;
  if (row === tipRow) return;
  if (!row) {
    hideTip();
    return;
  }
  const wasOpen = tipEl?.classList.contains("is-open") ?? false;
  tipRow = row;
  if (tipTimer) clearTimeout(tipTimer);
  if (wasOpen) {
    openTip(row); // already showing: move it, do not make the user wait again
    return;
  }
  tipTimer = setTimeout(() => {
    tipTimer = null;
    if (tipRow === row && row.isConnected) openTip(row);
  }, TIP_DELAY_MS);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Mount one pane. Returns the host's cleanup callback.
 * @param {HTMLElement} container
 * @returns {() => void}
 */
export function mount(container) {
  injectStyles();
  container.replaceChildren();

  const host = el("div", "tpm-host");
  const card = el("div", "tpm-card");

  const bar = el("div", "tpm-bar");
  // No title of its own: the pane header already says "Processes", and the
  // summary is the thing worth reading here.
  const chips = el("div", "tpm-chips");
  const refresh = document.createElement("button");
  refresh.className = "tpm-btn";
  refresh.type = "button";
  refresh.textContent = "Refresh";
  // Feedback on the MANUAL path only. Driving the label from `state.sampling`
  // would flip it every second on the automatic poll, which reads as a
  // flickering button rather than as progress. `paint` puts it back.
  refresh.addEventListener("click", () => {
    refresh.textContent = "Reading...";
    state.onRefresh?.();
  });
  bar.append(chips, el("div", "tpm-spacer"), refresh);

  const chart = buildChart();

  const head = el("div", "tpm-head");
  head.append(
    el("div", "", "Process"),
    el("div", "tpm-num", "PID"),
    el("div", "tpm-num", "CPU"),
    el("div", "tpm-num", "Memory"),
  );

  const body = el("div", "tpm-body");
  // Delegated, so it survives every rebuild of the row set; `mouseover` rather
  // than `mouseenter` for the same reason. Scrolling hides the bubble instead
  // of letting it float beside the row it no longer points at.
  body.addEventListener("mouseover", onHover);
  body.addEventListener("mousemove", trackPointer, { passive: true });
  body.addEventListener("mouseleave", hideTip);
  body.addEventListener("scroll", hideTip, { passive: true });
  card.append(bar, chart.root, head, body);
  host.append(card);
  container.append(host);

  /** Rendered rows by pid, for in-place number updates. @type {Map<number, Row>} */
  let rows = new Map();
  /** Pid + depth of what is currently rendered; a change means rebuild. */
  let signature = "";

  const paint = () => {
    const snap = state.last;
    refresh.textContent = "Refresh";
    chips.replaceChildren();
    if (!snap) {
      signature = "";
      rows = new Map();
      body.replaceChildren(
        el(
          "div",
          "tpm-note",
          state.error
            ? `Could not read the process list: ${state.error}`
            : "Reading the process list...",
        ),
      );
      return;
    }
    // Four chips and no more. The strip is a fixed 30 px row that CLIPS rather
    // than wraps, and it shares that row with the Refresh button, so a fifth
    // chip cost the agent count its tail on any pane under ~450 px. TEDI's own
    // share went to the chart overlay instead, which is full width and has an
    // empty corner.
    chips.append(
      el("span", "", `${snap.count} processes`),
      el("span", "", fmtBytes(snap.rss)),
      el("span", "", snap.cpuPct == null ? "CPU -" : `CPU ${fmtPct(snap.cpuPct)}`),
      el("span", "", snap.agents.length === 1 ? "1 agent" : `${snap.agents.length} agents`),
    );
    chart.draw(state.history, snap.rss, ownRss(snap.nodes));

    // TEDI and the terminals you opened; everything else is summed into the row
    // that owns it. The signature is still only pid + depth, so a shell that
    // starts and stops a process every second refreshes its numbers in place
    // instead of throwing away the row you are hovering.
    const shown = collapse(snap.nodes);
    const sig = shown.map((n) => `${n.pid}:${n.depth}`).join(",");
    if (sig === signature) {
      for (const n of shown) updateRow(rows.get(n.pid), n);
      return;
    }
    signature = sig;
    rows = new Map();
    const top = body.scrollTop;
    body.replaceChildren(
      ...shown.map((n) => {
        const row = rowOf(n);
        rows.set(n.pid, row);
        return row.root;
      }),
    );
    body.scrollTop = top;
  };

  state.views.add(paint);
  paint();
  // A pane in view samples fast; mounting one is the trigger for that.
  state.onRefresh?.();

  return () => {
    state.views.delete(paint);
    hideTip();
    chart.dispose();
    container.replaceChildren();
    // Closing the last pane must stop the sampler now, not at the next tick:
    // it is a whole PowerShell, and nothing is left to read it.
    state.onArm?.();
  };
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

/**
 * The memory trend, drawn on the same pixel grid the host's status bar uses:
 * 4 px square cells with a 2 px gap, filled cells in the accent and an empty
 * track at `muted-foreground/25` - the exact vocabulary of `PixelBar` in
 * `ExtensionStatusItems.tsx`, so the chart and the meter beside it read as one
 * component rather than two chart libraries.
 *
 * The y-axis auto-fits the window rather than starting at zero, because the
 * question it answers is "when is this high and when is it low", and against
 * 32 GB of installed RAM every real change is a flat line. The range is
 * labelled precisely so an auto-fitted axis cannot mislead, and a nearly flat
 * trace is held to a 2% band so noise is not magnified into a mountain range.
 *
 * Everything is two <path> elements (bodies and caps) rather than a thousand
 * <rect> nodes: a cell is four numbers in a path string, so a redraw is one
 * attribute write per second instead of a DOM diff over the whole grid.
 */
function buildChart() {
  const root = el("div", "tpm-chart");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  const off = document.createElementNS(SVG_NS, "path");
  off.setAttribute("class", "tpm-px-off");
  const on = document.createElementNS(SVG_NS, "path");
  on.setAttribute("class", "tpm-px-on");
  const cap = document.createElementNS(SVG_NS, "path");
  cap.setAttribute("class", "tpm-px-cap");
  svg.append(off, on, cap);

  const now = el("div", "tpm-cap is-now");
  const range = el("div", "tpm-cap is-range");
  const span = el("div", "tpm-cap is-span", "last 3 min");
  const own = el("div", "tpm-cap is-own");
  root.append(svg, now, range, span, own);

  /** Grid geometry, recomputed whenever the pane is resized. */
  let cols = 0;
  let rows = 0;
  let originY = 0;
  /** @type {{ t: number, rss: number }[]} */
  let lastHistory = [];
  let lastCurrent = 0;
  let lastOwn = 0;

  /** One cell as a path subpath. @param {number} x @param {number} y */
  const cell = (x, y) => `M${x} ${y}h${CELL}v${CELL}h-${CELL}z`;
  /** @param {number} c column index */
  const cellX = (c) => c * PITCH;
  /** @param {number} r row index, 0 at the bottom */
  const cellY = (r) => originY + (rows - 1 - r) * PITCH;

  const measure = () => {
    const w = root.clientWidth - CHART_PAD_X * 2;
    const h = root.clientHeight - CHART_PAD_TOP - CHART_PAD_BOTTOM;
    const nextCols = Math.max(1, Math.floor((w + GAP) / PITCH));
    const nextRows = Math.max(3, Math.floor((h + GAP) / PITCH));
    if (nextCols === cols && nextRows === rows) return false;
    cols = nextCols;
    rows = nextRows;
    const gridW = cols * PITCH - GAP;
    const gridH = rows * PITCH - GAP;
    originY = 0;
    svg.setAttribute("viewBox", `0 0 ${gridW} ${gridH}`);
    svg.setAttribute("width", String(gridW));
    svg.setAttribute("height", String(gridH));
    // The empty track only changes with the geometry, so it is built here and
    // not on every sample.
    const cells = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) cells.push(cell(cellX(c), cellY(r)));
    }
    off.setAttribute("d", cells.join(""));
    return true;
  };

  /**
   * @param {{ t: number, rss: number }[]} history
   * @param {number} current the whole tree
   * @param {number} ownBytes the part of it that is TEDI, see `ownRss`
   */
  const draw = (history, current, ownBytes) => {
    lastHistory = history;
    lastCurrent = current;
    lastOwn = ownBytes;
    now.textContent = fmtBytes(current);
    own.textContent = ownBytes > 0 ? `TEDI itself ${fmtBytes(ownBytes)}` : "";
    if (cols === 0) measure();
    const series = pixelSeries(history, cols);
    if (series.values.length === 0) {
      on.setAttribute("d", "");
      cap.setAttribute("d", "");
      range.textContent = "collecting...";
      return;
    }

    const bodies = [];
    const caps = [];
    for (let c = 0; c < cols; c++) {
      const v = series.values[c];
      if (v <= 0) continue; // a slice with no sample stays dark
      // At least one lit cell for any sample at all, so a value sitting on the
      // window's floor still reads as data rather than as a gap.
      const lit = Math.max(1, Math.min(rows, Math.round(v * rows)));
      const x = cellX(c);
      for (let r = 0; r < lit - 1; r++) bodies.push(cell(x, cellY(r)));
      caps.push(cell(x, cellY(lit - 1)));
    }
    on.setAttribute("d", bodies.join(""));
    cap.setAttribute("d", caps.join(""));
    range.textContent = `peak ${fmtBytes(series.hi)} · low ${fmtBytes(series.lo)}`;
  };

  // The grid is measured in real pixels, so it has to be rebuilt when the pane
  // is resized - a stretched pixel is not a pixel.
  const ro = new ResizeObserver(() => {
    if (measure()) draw(lastHistory, lastCurrent, lastOwn);
  });
  ro.observe(root);

  return { root, draw, dispose: () => ro.disconnect() };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** @typedef {{ root: HTMLElement, badge: HTMLElement, sub: HTMLElement,
 *              rolled: HTMLElement, cpu: HTMLElement, mem: HTMLElement }} Row */

/** @param {import("./procs.js").CollapsedNode} n @returns {Row} */
function rowOf(n) {
  const root = el("div", "tpm-row");
  root.dataset.role = n.role;

  const name = el("div", "tpm-name");
  name.style.paddingLeft = `${n.depth * 13}px`;
  const badge = el("span", "tpm-badge");
  const sub = el("span", "tpm-sub");
  const rolled = el("span", "tpm-rolled");
  name.append(el("span", "tpm-label", n.label), badge, sub, rolled);

  const cpu = el("div", "tpm-num");
  const mem = el("div", "tpm-num");
  root.append(name, el("div", "tpm-num", String(n.pid)), cpu, mem);
  const row = { root, badge, sub, rolled, cpu, mem };
  updateRow(row, n);
  return row;
}

/**
 * Everything that can change without the row set changing, refreshed in place.
 * That is not only the numbers: a terminal folds its whole subtree into itself,
 * so the count it hides and the name of what is running in it move while the
 * row stays put.
 * @param {Row | undefined} row @param {import("./procs.js").CollapsedNode} n
 */
function updateRow(row, n) {
  if (!row) return;
  // The badge follows what is INSIDE the row now, not the row's own role: an
  // agent is never a row of its own here, it is the reason one terminal weighs
  // a gigabyte and its neighbour weighs eighty megabytes.
  set(row.badge, n.inside.length > 0 ? "agent" : "");
  set(row.sub, n.sub);
  set(row.rolled, n.rolled > 0 ? `+${n.rolled}` : "");

  // The full command line is the answer to "what IS that node process", and the
  // hover bubble is the one place to put 240 characters without a second pane.
  // Carried on the element rather than closed over, so the delegated handler
  // works for rows this render did not create - and rewritten here, because a
  // row survives changes to everything in it.
  const title = `${n.label}${n.sub ? ` · ${n.sub}` : ""}  ·  pid ${n.pid}`;
  // Naming the process's OWN weight is the whole point of the line: the number
  // in the Memory column is a subtree, and the gap between the two is where a
  // gigabyte actually is. A row that folded nothing has no gap to explain.
  const more =
    n.rolled > 0
      ? `This process is ${fmtBytes(n.self)}. The ${n.rolled} ${n.rolled === 1 ? "process" : "processes"} it started make up the rest of its memory and CPU.`
      : "";
  const moved = row.root.dataset.tipTitle !== title || row.root.dataset.tipMore !== more;
  row.root.dataset.tipTitle = title;
  row.root.dataset.tipCmd = n.cmd || n.name;
  row.root.dataset.tipMore = more;
  if (moved) refreshTip(row.root);

  const cpu = n.cpuPct == null ? "-" : fmtPct(n.cpuPct);
  if (row.cpu.textContent !== cpu) row.cpu.textContent = cpu;
  row.cpu.classList.toggle("is-hot", n.cpuPct != null && n.cpuPct >= 5);
  const mem = fmtBytes(n.rss);
  if (row.mem.textContent !== mem) row.mem.textContent = mem;
  row.mem.classList.toggle("is-hot", n.rss >= 256 * 1024 * 1024);
}

/** Write only on a change: an unconditional assignment every second is a style
 *  recalc on a row nobody touched. @param {HTMLElement} node @param {string} text */
function set(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** Re-render every mounted pane. */
export function repaintViews() {
  for (const paint of state.views) {
    try {
      paint();
    } catch (err) {
      ctx?.logger?.warn?.("pane repaint failed", err);
    }
  }
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

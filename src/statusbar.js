// The status-bar meter: one item, sitting immediately right of the AI usage
// meters (the bar groups extensions that publish a meter ahead of the icon-only
// ones, then sorts by id).
//
// The headline is memory, because that is the number that grows quietly and
// that nobody can see any other way. Hovering adds the same pixel trend the
// pane draws plus CPU and memory; clicking opens the tree, which is where the
// per-process list belongs.
//
// Row text is budgeted for the host's fixed layout: `label` is a 56 px column
// (about 8 characters before it wraps), `note` never shrinks and is clipped by
// the popover at roughly 46 characters.

import { ctx, state } from "./runtime.js";
import { fmtBytes, fmtPct, ownRss } from "./procs.js";
import { pixelSeries, TIP_COLS } from "./chart.js";

const ITEM_ID = "procs";

/** Share of the machine's RAM at which the meter starts to complain. */
const WARN_SHARE = 0.25;
const ERROR_SHARE = 0.4;

/**
 * @param {import("./procs.js").Snapshot | null} snap
 * @param {number} totalMem physical RAM in bytes, 0 when unknown
 */
export function render(snap, totalMem) {
  if (!ctx) return;
  const open = state.onOpen ?? undefined;

  if (!snap) {
    ctx.statusBar.setItem({
      id: ITEM_ID,
      icon: "lucide:Activity",
      kind: "status",
      tooltip: state.error
        ? `TEDI processes\nCould not read the process list: ${state.error}`
        : "TEDI processes\nReading...",
      tone: state.error ? "error" : "default",
      // An empty bar while the first sample runs, so the item is born in the
      // meters group and does not hop left a second later: the host places
      // metered items before icon-only ones, and this one IS a meter, it just
      // has no number yet. Dropped on an error, where it is a state light.
      progress: state.error ? undefined : 0,
      onClick: open,
    });
    return;
  }

  const share = totalMem > 0 ? snap.rss / totalMem : null;
  /** @type {NonNullable<import("../tedi").StatusItem["tone"]>} */
  const tone =
    share == null
      ? "default"
      : share >= ERROR_SHARE
        ? "error"
        : share >= WARN_SHARE
          ? "warning"
          : "default";

  // Two numbers and the trend behind them. The process count and the agent
  // roster used to sit here too, but they are a LIST, and a list is what the
  // pane is for - hovering should answer "how heavy is this right now", and
  // clicking answers "why".
  /** @type {import("../tedi").StatusItemDetailRow[]} */
  const rows = [];
  if (snap.cpuPct != null) {
    rows.push({
      label: "CPU",
      progress: snap.cpuPct / 100,
      tone: snap.cpuPct >= 50 ? "warning" : "default",
      value: fmtPct(snap.cpuPct),
    });
  }
  rows.push({
    label: "Memory",
    progress: share ?? undefined,
    tone,
    value: fmtBytes(snap.rss),
    note: totalMem > 0 ? `of ${fmtBytes(totalMem)}` : "",
  });
  // The headline is the whole tree, and the whole tree is mostly other people's
  // work: the agents, dev servers and databases started from inside TEDI. This
  // row says what the app itself costs, so the meter turning orange sends you
  // to the thing that grew instead of to the uninstaller.
  const own = ownRss(snap.nodes);
  rows.push({
    label: "TEDI",
    progress: totalMem > 0 ? own / totalMem : undefined,
    value: fmtBytes(own),
    note: "app, UI and pty daemon",
  });
  rows.push({ label: "", note: "Click to open the tree" });

  // The same pixel grid the pane draws, from the same series maths, so the
  // hover and the pane cannot disagree about what the trend looks like.
  const series = pixelSeries(state.history, TIP_COLS);
  const chart =
    series.values.length > 0
      ? {
          values: series.values,
          tone,
          rows: 6,
          label: "last 3 min",
          note: `peak ${fmtBytes(series.hi)} · low ${fmtBytes(series.lo)}`,
        }
      : undefined;

  ctx.statusBar.setItem({
    id: ITEM_ID,
    icon: "lucide:Activity",
    kind: "status",
    tone,
    label: fmtBytes(snap.rss),
    progress: share ?? undefined,
    tooltip: plainTooltip(snap, totalMem),
    detail: { title: "TEDI processes", rows, chart },
    onClick: open,
  });
}

export function removeItem() {
  ctx?.statusBar.removeItem(ITEM_ID);
}

/** The accessible label, and the fallback on a host that ignores `detail`.
 *  @param {import("./procs.js").Snapshot} snap @param {number} totalMem */
function plainTooltip(snap, totalMem) {
  const lines = [
    "TEDI processes",
    `Memory ${fmtBytes(snap.rss)}${totalMem > 0 ? ` of ${fmtBytes(totalMem)}` : ""}`,
    `TEDI itself ${fmtBytes(ownRss(snap.nodes))}`,
  ];
  if (snap.cpuPct != null) lines.push(`CPU ${fmtPct(snap.cpuPct)}`);
  lines.push("Click to open the tree");
  return lines.join("\n");
}

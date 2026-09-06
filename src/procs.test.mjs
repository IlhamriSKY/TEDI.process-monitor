// The parsing and the tree walk, checked against a trimmed copy of a real
// Windows process table (taken from a live TEDI with two Claude sessions in
// its terminals). Run with `npm test`.
//
// What is worth checking here is exactly what a screenshot cannot show: that
// the daemon is a root even when the window that spawned it is gone, that a
// recycled pid does not adopt a stranger, that a `node` row says WHICH node,
// and that the status-bar rows fit the host's fixed-width layout.
import assert from "node:assert/strict";
import { setCtx, state } from "./runtime.js";
import {
  sample,
  parseWindows,
  parseUnix,
  parseLight,
  applyLight,
  buildSnapshot,
  cpuSampleOf,
  dropSelf,
  scriptToken,
  fmtBytes,
} from "./procs.js";
import { takeBlocks, latest } from "./stream.js";
import { pixelSeries, CHART_MS, TIP_COLS } from "./chart.js";
import { render } from "./statusbar.js";

const T0 = 1_788_696_000_000;

/** i pid, p ppid, n image, m rss, t CPU in 100 ns ticks, s start ms, c cmdline */
const p = (i, pp, n, c, m = 10 << 20, t = 0, s = T0) => ({ i, p: pp, n, c, m, t, s });

const TABLE = [
  // The window. Its own parent (12612) exited long ago and is not in the table.
  p(15264, 12612, "TEDIApp.exe", '"C:\\...\\TEDIApp.exe" ', 48 << 20),
  p(2504, 15264, "TEDIApp.exe", '"C:\\...\\TEDIApp.exe" --pty-daemon', 15 << 20),
  p(7284, 15264, "msedgewebview2.exe", '"...\\msedgewebview2.exe" --embedded-browser-webview=1'),
  p(13740, 7284, "msedgewebview2.exe", '"...\\msedgewebview2.exe" --type=renderer', 229 << 20),
  p(23920, 15264, "tedi-discord-helper.exe", '"...\\sidecar\\tedi-discord-helper.exe"'),
  p(
    26788,
    2504,
    "pwsh.exe",
    '"C:\\...\\pwsh.exe" -NoLogo -NoExit -ExecutionPolicy Bypass -File "C:\\...\\shell-integration\\powershell\\profile.ps1"',
  ),
  p(
    17128,
    2504,
    "conhost.exe",
    "\\\\?\\C:\\WINDOWS\\system32\\conhost.exe --headless --width 181 --signal 0x350",
  ),
  // The attached agent, and the tool tree it starts underneath itself.
  p(8016, 26788, "claude.exe", '"C:\\Users\\me\\.local\\bin\\claude.exe"', 559 << 20, 30_000_000),
  p(
    17852,
    8016,
    "cmd.exe",
    'C:\\WINDOWS\\system32\\cmd.exe /q /d /s /c "typescript-language-server.cmd ^"--stdio^""',
  ),
  p(
    15364,
    17852,
    "node.exe",
    '"D:\\node\\node.exe" "D:\\node\\node_modules\\typescript-language-server\\lib\\cli.mjs" "--stdio"',
  ),
  p(
    23904,
    15364,
    "node.exe",
    'D:\\node\\node.exe "d:\\repo\\extensions\\tedi.browser\\node_modules\\typescript\\lib\\tsserver.js" --useInferredProjectPerProjectRoot',
    707 << 20,
  ),
  // A second agent, launched as a bare script rather than a native binary.
  p(31336, 2504, "pwsh.exe", '"C:\\...\\pwsh.exe" -NoLogo'),
  p(
    23548,
    31336,
    "node.exe",
    'node "C:\\Users\\me\\.npm\\@anthropic-ai\\claude-code\\cli.js" --resume',
  ),
  // A daemon left over from a PREVIOUS run: its parent pid is not in the table
  // at all, so only the image name can root it.
  p(9100, 999_999, "TEDIApp.exe", '"C:\\...\\TEDIApp.exe" --pty-daemon', 12 << 20),
  p(9101, 9100, "bash.exe", '"C:\\Program Files\\Git\\bin\\bash.exe" -i'),
  // Nothing to do with TEDI.
  p(4000, 1000, "explorer.exe", "C:\\WINDOWS\\Explorer.EXE"),
  // A recycled pid: claims the daemon as its parent but started BEFORE it.
  p(
    4100,
    2504,
    "svchost.exe",
    "C:\\WINDOWS\\system32\\svchost.exe -k netsvcs",
    8 << 20,
    0,
    T0 - 60_000,
  ),
];

const rows = parseWindows(JSON.stringify(TABLE));
const snap = buildSnapshot(rows, null, T0 + 60_000, 8);
const byPid = new Map(snap.nodes.map((n) => [n.pid, n]));

// --- membership --------------------------------------------------------
assert.ok(!byPid.has(4000), "an unrelated process must not enter the tree");
assert.ok(!byPid.has(4100), "a recycled pid must not adopt a stranger into the tree");
assert.ok(byPid.has(9100), "a daemon whose parent has exited is still a root");
assert.ok(byPid.has(9101), "and it still brings its own children");
assert.equal(snap.count, TABLE.length - 2);

// --- shape -------------------------------------------------------------
assert.equal(snap.nodes[0].pid, 15264, "the window sorts first");
assert.equal(byPid.get(15264).depth, 0);
assert.equal(byPid.get(2504).depth, 1);
assert.equal(byPid.get(26788).depth, 2);
assert.equal(byPid.get(8016).depth, 3, "claude sits under its shell, under the daemon");
assert.equal(byPid.get(9100).depth, 0, "the orphaned daemon is a root of its own");

// --- roles -------------------------------------------------------------
const role = (pid) => byPid.get(pid).role;
assert.equal(role(15264), "app");
assert.equal(role(2504), "daemon");
assert.equal(role(7284), "webview");
assert.equal(role(13740), "webview", "a webview child is still the webview");
assert.equal(role(23920), "ext", "a sidecar is a direct child of the window");
assert.equal(role(26788), "terminal", "a shell under the daemon is a terminal");
assert.equal(role(17128), "child", "conhost is PTY plumbing, not a terminal");
assert.equal(role(8016), "agent", "claude.exe is an attached agent");
assert.equal(role(23548), "agent", "so is node running claude-code/cli.js");
assert.equal(role(15364), "child");
assert.deepEqual(
  snap.agents,
  ["claude", "claude-code"],
  "an agent is named by its script, not `node`",
);

// --- labels ------------------------------------------------------------
assert.equal(byPid.get(23904).label, "node");
assert.equal(byPid.get(23904).sub, "tsserver", "a bare `node` row must say which node");
assert.equal(byPid.get(15364).sub, "typescript-language-server", "generic path tail walks up");
assert.equal(byPid.get(2504).sub, "pty daemon");
assert.equal(byPid.get(13740).sub, "renderer");
assert.equal(byPid.get(26788).sub, "", "a terminal shell is the row, its profile is noise");
assert.equal(byPid.get(17128).sub, "", "flag values are not names");
assert.equal(scriptToken("cargo.exe clippy --all-targets"), "clippy");
assert.equal(
  scriptToken('cmd.exe /d /s /c "npx chrome-devtools-mcp@1.8.0"'),
  "npx chrome-devtools-mcp@1.8.0",
);
assert.equal(
  scriptToken("py.exe D:\\very\\long\\path\\an-extremely-long-script-name-here.py"),
  "an-extremely-long-script-name…",
);

// --- cpu ---------------------------------------------------------------
assert.equal(byPid.get(8016).cpuPct, null, "no CPU until there are two samples");
assert.equal(snap.cpuPct, null);
// One core busy for the whole 10 s window, on an 8-core machine, is 12.5%.
const later = buildSnapshot(
  parseWindows(JSON.stringify(TABLE.map((r) => (r.i === 8016 ? { ...r, t: 130_000_000 } : r)))),
  cpuSampleOf(rows, T0),
  T0 + 10_000,
  8,
);
const busy = later.nodes.find((n) => n.pid === 8016);
assert.equal(busy.cpuPct, 12.5);
assert.equal(later.cpuPct, 12.5);
// A pid whose start time moved is a different process; differencing it would
// invent a spike.
const restarted = buildSnapshot(
  parseWindows(
    JSON.stringify(TABLE.map((r) => (r.i === 8016 ? { ...r, t: 130_000_000, s: T0 + 5_000 } : r))),
  ),
  cpuSampleOf(rows, T0),
  T0 + 10_000,
  8,
);
assert.equal(restarted.nodes.find((n) => n.pid === 8016).cpuPct, null);

// --- unix parsing ------------------------------------------------------
const unix = parseUnix(
  [
    "  15264       1  49152    01:02:03 /opt/TEDI/TEDIApp",
    "   2504   15264  15360 1-00:00:01 /opt/TEDI/TEDIApp --pty-daemon",
    "not a process line",
  ].join("\n"),
);
assert.equal(unix.length, 2);
assert.equal(unix[0].name, "TEDIApp");
assert.equal(unix[0].rss, 49152 * 1024);
assert.equal(unix[0].cpuUs, 3723 * 1e6, "hh:mm:ss");
assert.equal(unix[1].cpuUs, (86400 + 1) * 1e6, "dd-hh:mm:ss");
assert.equal(buildSnapshot(unix, null, T0, 4).count, 2, "the Unix tree roots the same way");

// --- the sampler hides itself ------------------------------------------
// The poll's own shell is a direct child of the app window, so without this it
// would blink in and out of the tree on every refresh, conhost and all. The
// marker has to LEAD: the command line is cut at 240 characters and the Windows
// sampler is longer than that.
const withSelf = JSON.stringify([
  ...TABLE,
  p(
    5000,
    15264,
    "pwsh.exe",
    `pwsh -NoProfile -Command "$null='#tedi-pm-once';${"x".repeat(400)}"`.slice(0, 240),
  ),
  p(5001, 5000, "conhost.exe", "conhost.exe 0x4"),
  // Unix: `sh -c "a; b"` EXECS its last command, so the `ps` that replaces the
  // shell carries its own argv with no marker in it at all.
  p(5002, 15264, "ps", "ps -e -ww -o pid=,ppid=,rss=,time=,args="),
  p(5003, 15264, "ps", "ps -e -o pid=,rss=,time="),
]);
setCtx({ os: { platform: "windows" }, invoke: async () => ({ stdout: withSelf, stderr: "" }) });
const sampled = await sample(true);
const selfless = buildSnapshot(sampled, null, T0, 8);
assert.ok(!selfless.nodes.some((n) => n.pid === 5000), "the sampler must not list itself");
assert.ok(!selfless.nodes.some((n) => n.pid === 5001), "nor the conhost it drags along");
assert.ok(!selfless.nodes.some((n) => n.pid === 5002), "nor an exec'd full `ps`");
assert.ok(!selfless.nodes.some((n) => n.pid === 5003), "nor an exec'd light `ps`");
assert.equal(selfless.count, snap.count);
setCtx(null);

// --- the LIVE sampler is shown, not hidden -----------------------------
// It is one long-lived PowerShell rather than a new process per poll, and it
// costs real memory; hiding it would understate the total this pane reports.
const withLive = parseWindows(
  JSON.stringify([
    ...TABLE,
    p(
      6000,
      15264,
      "pwsh.exe",
      "pwsh -NoProfile -Command \"$null='#tedi-pm-live';$i=0;while(...)\"",
      130 << 20,
    ),
  ]),
);
const liveSnap = buildSnapshot(dropSelf(withLive), null, T0, 8);
const monitor = liveSnap.nodes.find((n) => n.pid === 6000);
assert.ok(monitor, "the live sampler stays in the tree");
assert.equal(monitor.role, "monitor");
assert.equal(monitor.sub, "process monitor");
assert.equal(liveSnap.rss, snap.rss + (130 << 20), "and its memory counts toward the total");
assert.deepEqual(liveSnap.agents, snap.agents, "a sampler is not an agent");

// --- light blocks ------------------------------------------------------
// A light block carries numbers only; it refreshes the tree the last full
// block built, drops what has exited, and never invents parentage.
const lightWin = parseLight(
  JSON.stringify([
    { i: 15264, m: 60 << 20, t: 130_000_000 },
    { i: 2504, m: 15 << 20, t: 0 },
  ]),
  true,
);
assert.equal(lightWin.get(15264).rss, 60 << 20);
assert.equal(lightWin.get(15264).cpuUs, 13_000_000, "100 ns ticks to microseconds");
const lightUnix = parseLight(" 15264 49152 01:02:03\n  2504 15360 0:00\n", false);
assert.equal(lightUnix.get(15264).rss, 49152 * 1024);
assert.equal(lightUnix.get(2504).cpuUs, 0);

const seed = new Map(rows.map((r) => [r.pid, { rss: r.rss, cpuUs: r.cpuUs }]));
// 8016 burns one core for the whole 2 s window; 13740 has exited.
const nextLight = new Map(seed);
nextLight.set(8016, { rss: 600 << 20, cpuUs: seed.get(8016).cpuUs + 2_000_000 });
nextLight.delete(13740);
const folded = applyLight(snap, nextLight, seed, T0 + 2000, 2000, 8);
assert.equal(folded.count, snap.count - 1, "an exited process leaves the tree");
assert.ok(!folded.nodes.some((n) => n.pid === 13740));
assert.equal(folded.nodes.find((n) => n.pid === 8016).rss, 600 << 20, "memory is refreshed");
assert.equal(folded.nodes.find((n) => n.pid === 8016).cpuPct, 12.5, "one core of eight, over 2 s");
assert.equal(folded.rss, snap.rss - (229 << 20) + (600 << 20) - (559 << 20));
assert.deepEqual(folded.agents, snap.agents, "roles survive a light block");

// --- stream framing ----------------------------------------------------
// The reader sees arbitrary chunks, not blocks: a block can arrive split, and
// several can arrive at once after the window was hidden.
{
  const a = takeBlocks("#L\n1 2 3\n#E\n#F\nrows\n#E\n#L\n4 5 6\n");
  assert.equal(a.blocks.length, 2, "two complete blocks");
  assert.deepEqual(
    a.blocks.map((b) => b.kind),
    ["L", "F"],
  );
  assert.equal(a.blocks[0].payload, "1 2 3\n");
  assert.ok(a.rest.endsWith("#L\n4 5 6\n"), "the partial block is kept for the next read");
  const b = takeBlocks(a.rest + "#E\n");
  assert.equal(b.blocks.length, 1);
  assert.equal(b.blocks[0].payload, "4 5 6\n");
  assert.equal(b.rest.trim(), "", "nothing but a possible partial marker is carried forward");
}
{
  // A backlog: only the newest full block and the newest light block after it
  // are worth applying, so a suspended window costs one parse, not sixty.
  const blocks = [
    { kind: "L", payload: "old" },
    { kind: "F", payload: "stale-tree" },
    { kind: "L", payload: "mid" },
    { kind: "F", payload: "fresh-tree" },
    { kind: "L", payload: "newest" },
  ];
  assert.deepEqual(
    latest(blocks).map((b) => b.payload),
    ["fresh-tree", "newest"],
    "newest full first, then the newest light after it",
  );
  assert.deepEqual(
    latest([{ kind: "L", payload: "only" }]).map((b) => b.payload),
    ["only"],
  );
  assert.deepEqual(latest([]), []);
}

// --- the chart series --------------------------------------------------
// One column per slice of time, holding that slice's PEAK, step-held across
// slices with no sample, and 0 before the first one. Shared by the pane's grid
// and the tooltip's chart, so this is the one place the axis can be wrong.
{
  const now = T0 + CHART_MS;
  const at = (msAgo) => now - msAgo;
  const flat = pixelSeries(
    [
      { t: at(120_000), rss: 1000 },
      { t: at(60_000), rss: 1000 },
    ],
    10,
    now,
  );
  assert.equal(flat.values.length, 10);
  assert.equal(flat.lo, 1000);
  assert.equal(flat.hi, 1000);
  assert.equal(flat.values[0], 0, "before the first sample the column is dark");
  assert.ok(flat.values[9] > 0 && flat.values[9] < 1, "a flat trace sits inside its 2% band");
  assert.equal(flat.values[8], flat.values[9], "and is held across empty slices");

  const spiky = pixelSeries(
    [
      { t: at(150_000), rss: 100 },
      { t: at(95_000), rss: 900 }, // a spike between two quiet samples
      { t: at(94_000), rss: 110 },
      { t: at(1_000), rss: 120 },
    ],
    6,
    now,
  );
  assert.equal(spiky.hi, 900);
  assert.equal(spiky.lo, 100);
  const peakCol = spiky.values.indexOf(Math.max(...spiky.values));
  assert.equal(peakCol, 2, "the spike lands in its own column");
  assert.ok(spiky.values[2] > 0.8, "and a bucket reports its PEAK, not its last sample");
  assert.equal(spiky.values[3], spiky.values[2], "an unsampled slice holds the last value");
  assert.ok(spiky.values[5] < 0.3, "and the next real sample ends the hold");
  assert.deepEqual(
    pixelSeries([{ t: at(1000), rss: 1 }], 8, now).values,
    [],
    "one point is no line",
  );
  assert.deepEqual(pixelSeries([], 8, now).values, []);
}

// --- status-bar detail fits the host's fixed layout --------------------
// `label` is a 56 px column (~8 characters before it wraps) and `note` never
// shrinks - it is clipped mid-word by the popover past ~46. Neither failure is
// visible to anything but an eye, so it is asserted here.
let item = null;
setCtx({ statusBar: { setItem: (i) => (item = i), removeItem: () => {} } });
state.onOpen = () => {};
state.history = [
  { t: Date.now() - 120_000, rss: 4 << 30 },
  { t: Date.now() - 60_000, rss: 5 << 30 },
  { t: Date.now(), rss: snap.rss },
];
render({ ...snap, cpuPct: 42.5 }, 34_359_738_368);
assert.ok(item, "render must set an item");
for (const r of item.detail.rows) {
  assert.ok(r.label.length <= 8, `detail label too wide: ${r.label}`);
  assert.ok((r.note ?? "").length <= 46, `detail note is clipped: ${r.note}`);
  assert.ok((r.value ?? "").length <= 12, `detail value too wide: ${r.value}`);
}
// Hover answers "how heavy is this"; the per-process list belongs to the pane.
assert.deepEqual(
  item.detail.rows.map((r) => r.label),
  ["CPU", "Memory", ""],
  "hover carries CPU and memory only",
);
assert.ok(item.detail.chart, "and the same pixel trend the pane draws");
assert.equal(item.detail.chart.values.length, TIP_COLS);
assert.ok(
  item.detail.chart.values.every((v) => v >= 0 && v <= 1),
  "chart values are 0..1",
);
assert.ok(item.detail.chart.values.length <= 48, "the popover holds at most 48 columns");
assert.equal(item.label, fmtBytes(snap.rss));
assert.ok(item.progress > 0 && item.progress < 1);
state.history = [];
setCtx(null);

console.log(`process tree: ok (${snap.count} nodes, ${fmtBytes(snap.rss)})`);

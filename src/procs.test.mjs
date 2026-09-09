// The parsing and the tree walk, checked against a trimmed copy of a real
// Windows process table (taken from a live TEDI with two Claude sessions in
// its terminals). Run with `npm test`.
//
// What is worth checking here is exactly what a screenshot cannot show: that
// the daemon is a root even when the window that spawned it is gone, that a
// recycled pid does not adopt a stranger, that a `node` row says WHICH node,
// and that the status-bar rows fit the host's fixed-width layout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setCtx, state } from "./runtime.js";
import {
  sample,
  parseWindows,
  parseUnix,
  parseLight,
  applyLight,
  buildSnapshot,
  collapse,
  cpuSampleOf,
  dropSelf,
  WIN_LOOP,
  UNIX_LOOP,
  scriptToken,
  fmtBytes,
  ownRss,
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

// --- collapse ----------------------------------------------------------
// What the pane draws: TEDI and the terminals you opened. Everything else is
// summed into the row that owns it, so the one property worth guarding is that
// NOTHING goes missing - a monitor that hides a gigabyte is worse than no
// monitor.
const shown = collapse(snap.nodes);
const shownBy = new Map(shown.map((n) => [n.pid, n]));
assert.deepEqual(
  shown.map((n) => n.pid),
  [15264, 2504, 26788, 31336, 9100, 9101],
  "the window, its daemon, the two shells under it, then the orphaned daemon and its shell",
);
assert.equal(
  shown.reduce((s, n) => s + n.rss, 0),
  snap.rss,
  "a collapsed tree weighs exactly what the full tree weighs",
);
assert.equal(
  shown.reduce((s, n) => s + n.pids.length, 0),
  snap.count,
  "and accounts for every process exactly once",
);
assert.ok(!shown.some((n) => n.pid === 13740), "a webview is not a row of its own");
assert.ok(!shown.some((n) => n.pid === 8016), "nor is an agent");
assert.ok(!shown.some((n) => n.pid === 17128), "nor is a conhost");

// A terminal weighs the shell plus everything the shell started.
assert.equal(shownBy.get(26788).rolled, 4, "the agent, its cmd shim and two node processes");
assert.equal(
  shownBy.get(26788).rss,
  [26788, 8016, 17852, 15364, 23904].reduce((s, pid) => s + byPid.get(pid).rss, 0),
);
assert.deepEqual(shownBy.get(26788).pids, [26788, 8016, 17852, 15364, 23904]);
assert.deepEqual(shownBy.get(26788).inside, ["claude"], "and it names the agent inside it");
assert.equal(shownBy.get(26788).sub, "claude", "which is what tells one shell from another");
assert.deepEqual(shownBy.get(31336).inside, ["claude-code"]);
assert.equal(shownBy.get(9101).rolled, 0, "an empty shell hides nothing");
assert.equal(shownBy.get(9101).sub, "", "and so claims to be running nothing");
assert.equal(shownBy.get(15264).rolled, 3, "the window carries its webviews and its sidecar");
assert.equal(shownBy.get(2504).sub, "pty daemon", "a role's own sub survives the fold");

// Depth is the depth of the COLLAPSED tree: claude sat at 3 and is gone, so its
// shell must not leave a hole where the indentation used to be.
assert.deepEqual(
  shown.map((n) => n.depth),
  [0, 1, 2, 2, 0, 1],
);

// Pure: the pane re-folds the SAME snapshot on every paint (and a light block
// hands back the same node objects), so a collapse that added into its input
// would ratchet the numbers up once a second.
assert.equal(
  collapse(snap.nodes).reduce((s, n) => s + n.rss, 0),
  snap.rss,
  "folding twice must not double anything",
);

// --- what the row itself weighs ----------------------------------------
// The Memory column is a SUBTREE, and a shell that reads 1.5G while the process
// it names holds 35M is the thing that sends people to Task Manager. `self` is
// frozen before the fold so the hover can name both.
assert.equal(shownBy.get(26788).self, byPid.get(26788).rss, "a row remembers its own weight");
assert.ok(shownBy.get(26788).self < shownBy.get(26788).rss, "which is not what the column shows");
assert.equal(shownBy.get(9101).self, shownBy.get(9101).rss, "a row that folded nothing has no gap");
assert.equal(shownBy.get(15264).self, byPid.get(15264).rss, "and so does the window");

// --- TEDI's own share --------------------------------------------------
// The window, the WebView2 processes it renders itself in, and the PTY daemon.
// Everything else in this tree has an owner you can point at.
const own = ownRss(snap.nodes);
assert.equal(
  own,
  snap.nodes
    .filter((n) => ["app", "daemon", "webview"].includes(n.role))
    .reduce((s, n) => s + n.rss, 0),
);
assert.ok(own < snap.rss, "and it is a fraction of the tree, which is the whole point");
assert.ok(
  !snap.nodes.some((n) => n.role === "agent" && ["app", "daemon", "webview"].includes(n.role)),
  "an agent is never counted as TEDI",
);
assert.equal(ownRss([]), 0, "and an empty tree is zero, not NaN");

// CPU rolls up the same way, summed then rounded once.
const busyShown = collapse(later.nodes).find((n) => n.pid === 26788);
assert.equal(busyShown.cpuPct, 12.5, "the shell reports the CPU its agent is burning");
assert.equal(
  collapse(snap.nodes).find((n) => n.pid === 26788).cpuPct,
  null,
  "and reports nothing at all before there are two samples to difference",
);

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
  p(5003, 15264, "ps", "ps -e -o pid=,time="),
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

// --- which memory number the sampler asks for --------------------------
// This is the one assertion that keeps the pane agreeing with Task Manager. A
// working set counts every shared page once per process that maps it, so
// summing it over TEDI's seven WebView2 processes over one set of Chromium DLLs
// came out 2.05x too big (878 MB against a true 428 MB, measured). Private
// working set is what Task Manager's Memory column shows, and it does not
// double count. An edit that quietly puts `WorkingSetSize` back would show up
// as the pane disagreeing with Task Manager by a factor of two, which is
// exactly the kind of thing nobody notices for a year.
assert.ok(
  WIN_LOOP.includes("WorkingSetPrivate"),
  "the Windows sampler must ask for the PRIVATE working set",
);
assert.ok(
  !WIN_LOOP.includes("WorkingSet64"),
  "and the light block must not smuggle a working set back in",
);
assert.ok(
  WIN_LOOP.includes("if($null -ne $v){$v}else{$_.WorkingSetSize}"),
  "with a fallback for a pid that started between the two queries",
);
// Anchored on `-o ` because `ppid=,rss=,time=` CONTAINS `pid=,rss=,time=`: the
// unanchored form passes against the full block's own field list and asserts
// nothing. Cost me a red run.
assert.ok(UNIX_LOOP.includes("-o pid=,time="), "the Unix light block drops rss too");
assert.ok(UNIX_LOOP.includes("-o pid=,ppid=,rss=,time=,args="), "the Unix FULL block still has it");
// Memory now rides the full block, so the full block runs more often. Moving
// memory off the light block made it cheap enough to pay for that and still
// cost less than before: 163 + 3 x 17 ms per 4 s against 174 + 7 x 50 per 8 s.
assert.ok(WIN_LOOP.includes("($i % 4)"), "a full block every fourth second on Windows");
assert.ok(UNIX_LOOP.includes("$((i % 4))"), "and on Unix");

// --- light blocks ------------------------------------------------------
// A light block carries CPU and liveness only; it refreshes the CPU column on
// the tree the last full block built, drops what has exited, and never invents
// parentage. Memory is NOT in it, on either platform, because the only cheap
// memory `Get-Process` and `ps` have is a working set, and a total built from
// working sets is roughly twice a total built from private working sets.
const lightWin = parseLight(
  JSON.stringify([
    { i: 15264, t: 130_000_000 },
    { i: 2504, t: 0 },
  ]),
  true,
);
assert.equal(lightWin.get(15264).cpuUs, 13_000_000, "100 ns ticks to microseconds");
const lightUnix = parseLight(" 15264 01:02:03\n  2504 0:00\n", false);
assert.equal(lightUnix.get(15264).cpuUs, 3723 * 1e6);
assert.equal(lightUnix.get(2504).cpuUs, 0);
assert.ok(!("rss" in lightUnix.get(15264)), "a light block carries no memory on either platform");
assert.ok(!("rss" in lightWin.get(15264)));

const seed = new Map(rows.map((r) => [r.pid, { cpuUs: r.cpuUs }]));
// 8016 burns one core for the whole 2 s window; 13740 has exited.
const nextLight = new Map(seed);
nextLight.set(8016, { cpuUs: seed.get(8016).cpuUs + 2_000_000 });
nextLight.delete(13740);
const folded = applyLight(snap, nextLight, seed, T0 + 2000, 2000, 8);
assert.equal(folded.count, snap.count - 1, "an exited process leaves the tree");
assert.ok(!folded.nodes.some((n) => n.pid === 13740));
assert.equal(folded.nodes.find((n) => n.pid === 8016).cpuPct, 12.5, "one core of eight, over 2 s");
// Memory rides the FULL block, so a light block must leave every survivor's
// number exactly where it found it. Mixing a working set in here from
// `Get-Process` is what would make the total jump by 2x between two ticks.
assert.equal(
  folded.nodes.find((n) => n.pid === 8016).rss,
  byPid.get(8016).rss,
  "a light block does not touch memory",
);
assert.equal(folded.rss, snap.rss - (229 << 20), "the total only loses what exited");
assert.deepEqual(folded.agents, snap.agents, "roles survive a light block");

// A light block drops the process that exited but NOT its descendants: those
// are alive and still cost memory. Re-parenting them onto its parent is what
// keeps the tree walkable - leave the hole and anything that follows parentage
// loses the whole subtree under it, which on a real machine is the agent's tool
// tree and a gigabyte with it. Seven of every eight blocks are light ones, so
// this is the path the pane spends its life on.
const shownPids = collapse(snap.nodes).map((n) => n.pid);
for (const [dead, label, sameRows] of [
  [8016, "an agent exits, its tool tree lives on", true],
  [17852, "a cmd shim exits, leaving node behind", true],
  [23904, "the deepest leaf exits", true],
  [26788, "the shell itself exits under its own subtree", false],
  [2504, "the daemon exits, orphaning both terminals", false],
]) {
  const gone = new Map(seed);
  gone.delete(dead);
  const after = applyLight(snap, gone, seed, T0 + 2000, 2000, 8);
  const rows = collapse(after.nodes);
  assert.ok(!after.nodes.some((n) => n.pid === dead), `${label}: the dead process is gone`);
  assert.equal(
    rows.reduce((s, n) => s + n.rss, 0),
    after.rss,
    `${label}: and the rows still weigh the whole tree`,
  );
  assert.equal(
    rows.reduce((s, n) => s + n.pids.length, 0),
    after.count,
    `${label}: with every survivor accounted for exactly once`,
  );
  // Not losing the memory is the floor; putting it on the RIGHT row is the
  // point. When the process that exited was one this pane never drew, the rows
  // must not move at all - its survivors belong to the same terminal they
  // belonged to a second ago, not to a new top-level row of their own.
  if (sameRows) {
    assert.deepEqual(
      rows.map((n) => n.pid),
      shownPids,
      `${label}: a process the pane never drew must not rearrange the pane`,
    );
  }
  // Depth must stay contiguous all the way down, not just for the orphan's own
  // row: a grandchild left two levels below a parent that moved up one is a
  // hole by another name.
  const depth = new Map(after.nodes.map((n) => [n.pid, n.depth]));
  for (const n of after.nodes) {
    const parent = depth.get(n.ppid);
    assert.equal(
      n.depth,
      parent === undefined ? 0 : parent + 1,
      `${label}: pid ${n.pid} sits one level under its surviving parent`,
    );
  }
}

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

// --- the chip strip has room for four chips, and no more ---------------
// It is a fixed 30 px row sharing its width with the Refresh button, and it
// CLIPS rather than wraps, so a fifth chip cost the agent count its tail on any
// pane under ~450 px. 0.1.4 shipped that and 0.1.5 took it back out. TEDI's own
// share belongs to the chart overlay, which is full width and had a free
// corner; this is a source-text check because neither failure is visible to
// anything but an eye.
const panelSrc = readFileSync(new URL("./panel.js", import.meta.url), "utf8");
const chipStrip = panelSrc.slice(panelSrc.indexOf("chips.append("));
assert.equal(chipStrip.slice(0, chipStrip.indexOf(");")).split("el(").length - 1, 4);
assert.ok(
  !chipStrip.slice(0, chipStrip.indexOf(");")).includes("ownRss"),
  "TEDI's own share must not go back into the chip strip",
);
assert.ok(panelSrc.includes("tpm-cap is-own"), "it lives on the chart overlay instead");

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
// TEDI's own share is a CAPTION, not a row. As a row its note was the widest
// thing in the popover, which stretched the content box ~57 px past the chart
// grid: the caption then right-aligned to the box rather than to the last
// column and the chart read as cut off. Its bar was dead too - 555M of 32G
// rounds to zero lit cells out of ten.
assert.ok(
  !item.detail.rows.some((r) => (r.value ?? "").includes(fmtBytes(ownRss(snap.nodes)))),
  "the app's own share must not go back into the rows",
);
assert.ok(item.detail.chart, "and the same pixel trend the pane draws");
assert.equal(item.detail.chart.note, `TEDI itself ${fmtBytes(ownRss(snap.nodes))}`);
// The caption is one flex row of two shrink-0 spans over the grid's own width:
// TIP_COLS columns at the host's 6 px pitch, less the trailing gap, is 238 px,
// and the gap between the two spans is 12 px. At 10 px the widest system font
// averages under 5.4 px a character, so 40 characters is the budget that keeps
// the caption inside the chart it belongs to.
assert.ok(
  item.detail.chart.label.length + item.detail.chart.note.length <= 40,
  `chart caption is wider than its grid: ${item.detail.chart.label} / ${item.detail.chart.note}`,
);
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

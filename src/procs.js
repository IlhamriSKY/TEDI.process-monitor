// Sampling and shaping. One shell call per poll returns the OS process table;
// everything after that is pure functions, which is what `procs.test.mjs`
// exercises.
//
// Why a shell call and not a Tauri command: TEDI ships no process-table API and
// adding one would mean a core release for an extension, so this reads the same
// table Task Manager and `ps` read. Windows goes through CIM (`tasklist` has no
// parent pid, and `wmic` is gone from Windows 11 24H2); Unix through `ps`.
//
// The tree is rooted at every live process whose image is TEDI's own binary,
// which is both the window AND the PTY daemon (the daemon is the same
// executable re-launched with `--pty-daemon`). That matters: the daemon
// outlives the window it was spawned from, so after a restart its parent is a
// pid that no longer exists and walking down from the window alone would miss
// every terminal in the app.

import { ctx } from "./runtime.js";

/** One row of the OS process table, normalised across platforms. */
/** @typedef {{ pid: number, ppid: number, name: string, cmd: string, rss: number, cpuUs: number, startMs: number }} RawProc */

/** A process kept in the tree, with its display shape resolved. */
/** @typedef {"app"|"daemon"|"webview"|"terminal"|"agent"|"ext"|"monitor"|"child"} Role */
/** @typedef {RawProc & { depth: number, role: Role, label: string, sub: string, cpuPct: number | null }} ProcNode */

/** @typedef {{ at: number, nodes: ProcNode[], count: number, rss: number, cpuPct: number | null, agents: string[] }} Snapshot */

// Truncating the command line in the shell rather than here keeps the payload
// bounded: a machine with 600 Chromium processes would otherwise return most of
// a megabyte and `shell_run_command` caps its output at 256 KB, which would cut
// the JSON mid-token and lose the whole sample.
const CMD_CHARS = 240;

/**
 * A no-op statement at the FRONT of both sample commands, so the sampler can
 * recognise ITSELF in the table it just read and drop it. Without this, the
 * shell TEDI spawns for the poll is a direct child of the app window, so every
 * refresh would show a `pwsh` running a CIM query blinking in and out of the
 * tree with a conhost of its own. Dropping the row drops its children too:
 * their parent pid no longer resolves to anything.
 *
 * It has to lead, not trail. The command line is truncated at `CMD_CHARS`, and
 * the Windows sampler is longer than that - a marker at the end would be cut
 * off exactly in the row it exists to identify.
 */
const SELF_MARKER = "#tedi-pm-once";

/**
 * The live sampler carries a DIFFERENT marker, and is deliberately NOT hidden.
 * It is one stable process rather than a new one every poll, and on Windows it
 * is a PowerShell, so it costs real memory (~83 MB of that is PowerShell
 * existing at all). Hiding it would understate the very total this pane exists
 * to report, so it is shown, labelled, and killed the moment the pane closes.
 */
const LIVE_MARKER = "#tedi-pm-live";

/**
 * ...and the marker cannot be the whole story on Unix. A shell running
 * `sh -c "a; b"` EXECS its last command instead of forking it, so the `ps`
 * process inherits the shell's pid but carries its OWN argv, with no marker in
 * it. These are the two `ps` invocations this extension makes; a row whose
 * command line contains one of them is the sampler, whichever process it
 * turned out to be.
 */
const PS_FULL_FIELDS = "pid=,ppid=,rss=,time=,args=";
const PS_LIGHT_FIELDS = "pid=,rss=,time=";

/** Everything the tree needs: parentage, names, command lines, memory, CPU. */
const WIN_FULL =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,UserModeTime,KernelModeTime,CreationDate|" +
  "Select-Object @{n='i';e={$_.ProcessId}},@{n='p';e={$_.ParentProcessId}},@{n='n';e={$_.Name}}," +
  "@{n='m';e={$_.WorkingSetSize}},@{n='t';e={$_.UserModeTime+$_.KernelModeTime}}," +
  "@{n='s';e={[int64]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds()}}," +
  "@{n='c';e={if($_.CommandLine){$_.CommandLine.Substring(0,[Math]::Min(" +
  CMD_CHARS +
  ",$_.CommandLine.Length))}}}|" +
  "ConvertTo-Json -Compress";

/**
 * Numbers only, for the rows the tree already knows. Deliberately NOT CIM:
 * `Get-Process` reads the same working set and CPU time in ~50 ms against
 * ~350 ms for the CIM projection, because it never opens a process to read its
 * command line. (Its `.Parent` and `.CommandLine` properties are the opposite
 * of cheap - 42 SECONDS for 350 processes - which is why the full sample stays
 * on CIM.)
 */
const WIN_LIGHT =
  "Get-Process|Select-Object @{n='i';e={$_.Id}},@{n='m';e={$_.WorkingSet64}}," +
  "@{n='t';e={$_.TotalProcessorTime.Ticks}}|ConvertTo-Json -Compress";

const WIN_PREFIX = `$null='${SELF_MARKER}';$ErrorActionPreference='SilentlyContinue';`;
const WIN_SAMPLE = WIN_PREFIX + WIN_FULL;

// macOS documents `-e` as identical to `-A` (it is `-E` that dumps the
// environment there), so one command covers Linux and macOS. No creation time:
// `lstart` is an unparseable date string on macOS, and Unix pids cycle slowly
// enough that the reuse guard it feeds is not worth a second format to parse.
// `true` takes and ignores an argument in sh, bash, zsh and fish alike, which
// `:` does not (fish has no `:` builtin).
const UNIX_PREFIX = `true '${SELF_MARKER}';`;
// `-w -w` as two tokens rather than `-ww`: both procps and BSD read a repeated
// `w` as "no width limit", and spelling it out avoids depending on either one's
// tolerance for the doubled form. Without it procps clips `args` to 80 columns
// when stdout is not a terminal, which is exactly our case.
const UNIX_FULL = `ps -e -w -w -o ${PS_FULL_FIELDS}`;
const UNIX_LIGHT = `ps -e -o ${PS_LIGHT_FIELDS}`;
const UNIX_SAMPLE = `${UNIX_PREFIX} ${UNIX_FULL}`;

/**
 * The streaming sampler: one long-lived shell that prints a framed block per
 * second, a full one every eighth. This is the whole reason the pane can update
 * every second without being a CPU hog: on Windows ANY freshly spawned process
 * costs ~600 ms before it does a thing (PowerShell start-up plus WMI's first
 * connection, and `tasklist` is no cheaper), so a one-shot poll at this cadence
 * would burn a third of a core. Inside a warm shell the same work is ~170 ms
 * full / ~50 ms light, i.e. about 6% of one core at a 1 s cadence.
 *
 * `#F` / `#L` open a block and `#E` closes it, identically on both platforms,
 * so one framing parser serves both and the payload inside each block is
 * exactly what the one-shot sampler already knows how to read.
 */
export const WIN_LOOP =
  `$null='${LIVE_MARKER}';$ErrorActionPreference='SilentlyContinue';` +
  "$i=0;while($true){if(($i % 8) -eq 0){'#F';" +
  WIN_FULL +
  ";'#E'}else{'#L';" +
  WIN_LIGHT +
  ";'#E'};$i++;Start-Sleep -Milliseconds 1000}";

export const UNIX_LOOP =
  `true '${LIVE_MARKER}';` +
  ` i=0; while :; do if [ $((i % 8)) -eq 0 ]; then echo '#F'; ${UNIX_FULL}; else echo '#L'; ${UNIX_LIGHT}; fi; echo '#E'; i=$((i+1)); sleep 1; done`;

/**
 * Read the process table.
 * @param {boolean} isWindows
 * @returns {Promise<RawProc[]>}
 */
export async function sample(isWindows) {
  const command = isWindows ? WIN_SAMPLE : UNIX_SAMPLE;
  const out = await ctx?.invoke("shell_run_command", { command, cwd: null, timeoutSecs: 20 });
  const stdout = String(out?.stdout ?? "");
  // The host caps command output at 256 KB. Past that the JSON is cut
  // mid-token and `JSON.parse` fails with something unreadable, so name the
  // real cause instead.
  if (out?.truncated) throw new Error("the process list was too large to read in one go");
  if (!stdout.trim()) {
    const why = String(out?.stderr ?? "")
      .trim()
      .split(/\r?\n/)[0];
    throw new Error(why || "the process list command returned nothing");
  }
  return dropSelf(isWindows ? parseWindows(stdout) : parseUnix(stdout));
}

/** Drop the sampler's own processes. See `SELF_MARKER` and `PS_FULL_FIELDS`.
 *  @param {RawProc[]} rows @returns {RawProc[]} */
export function dropSelf(rows) {
  return rows.filter(
    (r) =>
      !r.cmd.includes(SELF_MARKER) &&
      !r.cmd.includes(PS_FULL_FIELDS) &&
      !r.cmd.includes(PS_LIGHT_FIELDS),
  );
}

/**
 * Physical RAM in bytes, so the status bar can say what share of the machine
 * TEDI is holding rather than a number nobody can scale. Read once - it does
 * not change while the app is running. `0` when the platform refuses, which
 * simply drops the bar and keeps the figure.
 * @param {boolean} isWindows
 */
export async function readTotalMemory(isWindows) {
  const command = isWindows
    ? `${WIN_PREFIX}(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory`
    : `${UNIX_PREFIX} sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/{print $2*1024;exit}' /proc/meminfo 2>/dev/null || echo 0`;
  try {
    const out = await ctx?.invoke("shell_run_command", { command, cwd: null, timeoutSecs: 10 });
    const first = String(out?.stdout ?? "")
      .split(/\r?\n/)[0]
      .trim();
    return /^\d+$/.test(first) ? Number(first) : 0;
  } catch {
    return 0;
  }
}

/**
 * Parse the CIM JSON dump. `t` is the summed kernel + user time in 100 ns
 * ticks; every platform is normalised to CPU microseconds here so the delta
 * maths downstream is platform-blind.
 * @param {string} stdout
 * @returns {RawProc[]}
 */
export function parseWindows(stdout) {
  const data = JSON.parse(stdout);
  const list = Array.isArray(data) ? data : [data];
  /** @type {RawProc[]} */
  const out = [];
  for (const r of list) {
    const pid = num(r?.i);
    if (!pid) continue; // pid 0 is the idle process, and never ours
    out.push({
      pid,
      ppid: num(r?.p),
      name: String(r?.n ?? ""),
      cmd: String(r?.c ?? ""),
      rss: num(r?.m),
      cpuUs: Math.round(num(r?.t) / 10),
      startMs: num(r?.s),
    });
  }
  return out;
}

/**
 * Parse `ps` output: pid, ppid, rss (KB), cumulative CPU time, then the whole
 * command line. The name is the basename of argv0, which is what the Windows
 * side reports as the image name.
 * @param {string} stdout
 * @returns {RawProc[]}
 */
export function parseUnix(stdout) {
  /** @type {RawProc[]} */
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
    if (!m) continue;
    const cmd = m[5].slice(0, CMD_CHARS);
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: baseName(firstToken(cmd)),
      cmd,
      rss: Number(m[3]) * 1024,
      cpuUs: Math.round(cpuSeconds(m[4]) * 1e6),
      startMs: 0,
    });
  }
  return out;
}

/**
 * The light block: memory and CPU time per pid, nothing else. Windows sends
 * `Get-Process` JSON (ticks of 100 ns), Unix a `pid rss time` table.
 * @param {string} text
 * @param {boolean} isWindows
 * @returns {Map<number, { rss: number, cpuUs: number }>}
 */
export function parseLight(text, isWindows) {
  /** @type {Map<number, { rss: number, cpuUs: number }>} */
  const out = new Map();
  if (isWindows) {
    const data = JSON.parse(text);
    for (const r of Array.isArray(data) ? data : [data]) {
      const pid = num(r?.i);
      if (pid) out.set(pid, { rss: num(r?.m), cpuUs: Math.round(num(r?.t) / 10) });
    }
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (m) {
      out.set(Number(m[1]), {
        rss: Number(m[2]) * 1024,
        cpuUs: Math.round(cpuSeconds(m[3]) * 1e6),
      });
    }
  }
  return out;
}

/**
 * Fold a light block into the tree the last full block built: new numbers for
 * the rows that are still alive, and the dead ones dropped so the totals stay
 * honest. Processes STARTED since the last full block do not appear until the
 * next one - the light block carries no parentage, and guessing where a row
 * belongs is worse than showing it a few seconds late.
 *
 * CPU here is differenced by pid alone (the light block has no start time). A
 * pid recycled inside one full-sample window could therefore report a spike;
 * the clamp bounds it and the next full block corrects it.
 *
 * @param {Snapshot} snap
 * @param {Map<number, { rss: number, cpuUs: number }>} light
 * @param {Map<number, { rss: number, cpuUs: number }> | null} prev
 * @param {number} at
 * @param {number} dtMs milliseconds since `prev` was taken
 * @param {number} ncpu
 * @returns {Snapshot}
 */
export function applyLight(snap, light, prev, at, dtMs, ncpu) {
  /** @type {ProcNode[]} */
  const nodes = [];
  let rss = 0;
  let cpu = 0;
  let cpuKnown = false;
  /** @type {string[]} */
  const agents = [];
  for (const n of snap.nodes) {
    const now = light.get(n.pid);
    if (!now) continue; // exited since the last full block
    const was = prev?.get(n.pid);
    let cpuPct = n.cpuPct;
    if (was && dtMs > 0) {
      cpuPct = Math.max(
        0,
        Math.min(100, (now.cpuUs - was.cpuUs) / (dtMs * 10 * Math.max(1, ncpu))),
      );
      cpuPct = Math.round(cpuPct * 10) / 10;
    }
    const node = { ...n, rss: now.rss, cpuPct };
    nodes.push(node);
    rss += node.rss;
    if (cpuPct != null) {
      cpu += cpuPct;
      cpuKnown = true;
    }
    if (node.role === "agent") agents.push(node.sub || node.label);
  }
  return {
    at,
    nodes,
    count: nodes.length,
    rss,
    cpuPct: cpuKnown ? Math.min(100, Math.round(cpu * 10) / 10) : null,
    agents,
  };
}

/** `[[dd-]hh:]mm:ss[.frac]` (Linux) or `mm:ss.ff` (macOS) to seconds.
 *  @param {string} t */
export function cpuSeconds(t) {
  const [days, rest] = t.includes("-") ? t.split("-") : ["0", t];
  const parts = rest.split(":").map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + (Number.isFinite(p) ? p : 0);
  return Number(days) * 86400 + secs;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/** TEDI's own executable, window and PTY daemon alike. */
const APP_RE = /^tediapp(\.exe)?$/i;
const DAEMON_RE = /--pty-daemon/;
const LIVE_RE = new RegExp(LIVE_MARKER);
// WebView2 on Windows; WebKitGTK's helper processes on Linux
// (WebKitWebProcess, WebKitNetworkProcess, WebKitGPUProcess); WKWebView's on
// macOS - though those are launchd children, not ours, so on macOS the tree
// simply has no webview rows to label.
const WEBVIEW_RE = /msedgewebview2|webkit[\w.]*(process|webcontent)/i;
// ConPTY plumbing rather than a terminal of its own: one conhost per PTY.
const CONHOST_RE = /^conhost(\.exe)?$/i;

/**
 * AI CLIs that attach to a TEDI terminal. Tier one is an exact argv0 basename
 * (`claude.exe`, `codex`), tier two a marker in the command line, which is what
 * catches the ones that run as `node <somewhere>/claude-code/cli.js` and would
 * otherwise show up as another anonymous `node`.
 * Kept deliberately close to the roster in the host's `cliAgents.ts`.
 */
const AGENT_BINS = new Set([
  "claude",
  "claude-code",
  "codex",
  "opencode",
  "copilot",
  "gemini",
  "grok",
  "aider",
  "goose",
  "cody",
  "cursor-agent",
  "amazon-q",
  "ollama",
  "crush",
  "droid",
  "qwen",
  "pi",
]);
const AGENT_PATH_RE =
  /(claude-code|anthropic-ai[\\/]claude|codex-cli|[\\/]codex[\\/]bin|opencode|gemini-cli|cursor-agent|copilot-cli)/i;

/**
 * Build the display tree from one raw sample.
 *
 * @param {RawProc[]} rows every live process
 * @param {import("./runtime.js").CpuSample | null} prev the previous sample, for the CPU delta
 * @param {number} at now, epoch ms
 * @param {number} ncpu logical cores, to normalise CPU against the whole machine
 * @returns {Snapshot}
 */
export function buildSnapshot(rows, prev, at, ncpu) {
  /** @type {Map<number, RawProc>} */
  const byPid = new Map();
  for (const r of rows) byPid.set(r.pid, r);

  // A pid is only a parent if it is still alive AND started no later than the
  // child. Windows recycles pids aggressively, so without the second test a
  // long-dead parent's number can hand a stranger's subtree to the app.
  /** @param {RawProc} r @returns {RawProc | null} */
  const parentOf = (r) => {
    const p = byPid.get(r.ppid);
    if (!p || p.pid === r.pid) return null;
    if (r.startMs && p.startMs && p.startMs > r.startMs) return null;
    return p;
  };

  /** @type {Map<number, RawProc[]>} */
  const kids = new Map();
  for (const r of rows) {
    const p = parentOf(r);
    if (!p) continue;
    const list = kids.get(p.pid);
    if (list) list.push(r);
    else kids.set(p.pid, [r]);
  }

  // Members: every app process and everything below it.
  /** @type {Set<number>} */
  const members = new Set();
  for (const r of rows) {
    if (!APP_RE.test(stripExt(r.name))) continue;
    const stack = [r];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || members.has(cur.pid)) continue;
      members.add(cur.pid);
      for (const k of kids.get(cur.pid) ?? []) stack.push(k);
    }
  }

  // Roots: members whose parent is not itself a member. Normally that is the
  // app window plus a daemon left over from a previous run, but a TEDI launched
  // from inside a TEDI terminal is a member of its host's tree, and would be
  // listed twice if every app process were treated as a root.
  const roots = rows
    .filter((r) => members.has(r.pid))
    .filter((r) => {
      const p = parentOf(r);
      return !p || !members.has(p.pid);
    })
    .sort((a, b) => rootRank(a) - rootRank(b) || a.startMs - b.startMs || a.pid - b.pid);

  /** @type {ProcNode[]} */
  const nodes = [];
  /** @param {RawProc} r @param {number} depth @param {Role | null} parentRole */
  const walk = (r, depth, parentRole) => {
    const role = roleFor(r, parentRole);
    const { label, sub } = labelFor(r, role);
    nodes.push({ ...r, depth, role, label, sub, cpuPct: cpuPctFor(r, prev, at, ncpu) });
    const children = (kids.get(r.pid) ?? [])
      .filter((k) => members.has(k.pid))
      .sort((a, b) => b.rss - a.rss || a.pid - b.pid);
    for (const k of children) walk(k, depth + 1, role);
  };
  for (const r of roots) walk(r, 0, null);

  let rss = 0;
  let cpu = 0;
  let cpuKnown = false;
  /** @type {string[]} */
  const agents = [];
  for (const n of nodes) {
    rss += n.rss;
    if (n.cpuPct != null) {
      cpu += n.cpuPct;
      cpuKnown = true;
    }
    // An agent launched as `node .../claude-code/cli.js` is labelled `node`;
    // its resolved script is the name worth reporting.
    if (n.role === "agent") agents.push(n.sub || n.label);
  }
  return {
    at,
    nodes,
    count: nodes.length,
    rss,
    cpuPct: cpuKnown ? Math.min(100, Math.round(cpu * 10) / 10) : null,
    agents,
  };
}

/**
 * Snapshot the cumulative CPU counters for the next delta.
 * @param {RawProc[]} rows
 * @param {number} at
 * @returns {import("./runtime.js").CpuSample}
 */
export function cpuSampleOf(rows, at) {
  /** @type {Map<number, { cpuUs: number, startMs: number }>} */
  const cpu = new Map();
  for (const r of rows) cpu.set(r.pid, { cpuUs: r.cpuUs, startMs: r.startMs });
  return { at, cpu };
}

/**
 * CPU since the previous sample, as a percentage of the WHOLE machine (what
 * Task Manager shows), so the numbers in a column sum to something meaningful.
 * `null` until there is a previous reading for this exact process - a recycled
 * pid with a different start time is a different process, and differencing the
 * two would invent a spike.
 * @param {RawProc} r
 * @param {import("./runtime.js").CpuSample | null} prev
 * @param {number} at
 * @param {number} ncpu
 */
function cpuPctFor(r, prev, at, ncpu) {
  if (!prev) return null;
  const was = prev.cpu.get(r.pid);
  if (!was || was.startMs !== r.startMs) return null;
  const dtMs = at - prev.at;
  if (dtMs <= 0) return null;
  const pct = (r.cpuUs - was.cpuUs) / (dtMs * 10 * Math.max(1, ncpu));
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/** Reading order for the forest: the window, then any daemon that outlived its
 *  own window, then whatever else got orphaned. @param {RawProc} r */
function rootRank(r) {
  if (!APP_RE.test(stripExt(r.name))) return 2;
  return DAEMON_RE.test(r.cmd) ? 1 : 0;
}

/**
 * @param {RawProc} r
 * @param {Role | null} parentRole
 * @returns {Role}
 */
export function roleFor(r, parentRole) {
  const base = stripExt(r.name);
  if (APP_RE.test(base)) return DAEMON_RE.test(r.cmd) ? "daemon" : "app";
  if (LIVE_RE.test(r.cmd)) return "monitor";
  if (isAgent(base, r.cmd)) return "agent";
  if (WEBVIEW_RE.test(r.name) || parentRole === "webview") return "webview";
  if (parentRole === "daemon") return CONHOST_RE.test(r.name) ? "child" : "terminal";
  if (parentRole === "app") return "ext";
  return "child";
}

/** @param {string} base @param {string} cmd */
function isAgent(base, cmd) {
  return AGENT_BINS.has(base.toLowerCase()) || AGENT_PATH_RE.test(cmd);
}

/**
 * What to show in the name column: the executable, plus the one token from its
 * arguments that says which of the fifteen `node` processes this is.
 * @param {RawProc} r
 * @param {Role} role
 */
export function labelFor(r, role) {
  const label = webviewName(r.name) ?? stripExt(r.name);
  if (role === "daemon") return { label, sub: "pty daemon" };
  // This pane's own sampler. Named rather than hidden: it is the one row here
  // that exists because you opened this pane.
  if (role === "monitor") return { label, sub: "process monitor" };
  if (role === "webview") return { label, sub: flagValue(r.cmd, "--type") };
  // A terminal's shell is launched by TEDI with its own integration profile;
  // naming that profile in every row is noise, the shell IS the row.
  if (role === "terminal" || role === "app") return { label, sub: "" };
  const sub = scriptToken(r.cmd);
  return { label, sub: sub.toLowerCase() === label.toLowerCase() ? "" : sub };
}

/** @param {string} name */
function webviewName(name) {
  if (/msedgewebview2/i.test(name)) return "WebView2";
  if (/webkit/i.test(name)) return "WebKit";
  return null;
}

/** Value of `--flag=value` in a command line, else "".
 *  @param {string} cmd @param {string} flag */
function flagValue(cmd, flag) {
  const m = new RegExp(`${flag}=([\\w.-]+)`).exec(cmd);
  return m ? m[1] : "";
}

const MAX_SUB = 30;
// Path segments that name nothing: the useful name is the directory above.
const GENERIC = new Set([
  "cli",
  "index",
  "main",
  "bin",
  ".bin",
  "lib",
  "libexec",
  "dist",
  "build",
  "src",
  "out",
  "app",
  "node_modules",
  "server",
  "start",
  "run",
  "entry",
]);

/**
 * The most identifying argument: the first that looks like a path or a package
 * (`.../typescript-language-server/lib/cli.mjs` -> `typescript-language-server`),
 * else the first plain word (`cargo clippy --all-targets` -> `clippy`). Flags,
 * their numeric values and hex handles are all skipped, because a row reading
 * `conhost 181` is worse than one reading `conhost`.
 * @param {string} cmd
 */
export function scriptToken(cmd) {
  const args = tokenize(cmd).slice(1).filter(isCandidate);
  const pick = args.find((a) => /[\\/.]/.test(a)) ?? args[0];
  if (!pick) return "";
  // `cmd.exe /c "npx ^"pkg^""` survives tokenizing with its caret escapes
  // attached, and a segment ending in `.cmd ^` defeats the extension strip.
  const segs = pick
    .split(/[\\/]+/)
    .map(scrub)
    .filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = stripExt(segs[i]);
    if (seg && !GENERIC.has(seg.toLowerCase())) return clip(seg, MAX_SUB);
  }
  return clip(stripExt(segs[segs.length - 1] ?? pick), MAX_SUB);
}

/** @param {string} t */
function isCandidate(t) {
  if (!t) return false;
  if (t.startsWith("-")) return false;
  if (/^\/[a-z]$/i.test(t)) return false; // cmd.exe style: /d /s /c
  if (/^[-+]?(0x)?[\da-f]+$/i.test(t) && t.length <= 10) return false; // a flag's value
  return true;
}

/** Split a command line on whitespace, keeping quoted runs together.
 *  @param {string} cmd @returns {string[]} */
export function tokenize(cmd) {
  /** @type {string[]} */
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
/** @param {string} cmd */
const firstToken = (cmd) => tokenize(cmd)[0] ?? "";
/** @param {string} p */
const baseName = (p) =>
  p
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop() ?? p;
/** Shell escape residue at either end of a token. @param {string} s */
const scrub = (s) => s.replace(/^[\s"'^]+/, "").replace(/[\s"'^]+$/, "");
/** @param {string} n */
const stripExt = (n) => baseName(n).replace(/\.(exe|com|bat|cmd|js|mjs|cjs|ps1|py|sh)$/i, "");
/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Bytes as a status-bar sized string: 512K, 48M, 3.9G.
 *  @param {number} b */
export function fmtBytes(b) {
  if (!b) return "0";
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}K`;
  if (b < 1024 * 1024 * 1024) return `${Math.round(b / (1024 * 1024))}M`;
  const g = b / (1024 * 1024 * 1024);
  return `${g < 10 ? g.toFixed(1) : Math.round(g)}G`;
}

/** @param {number | null} p */
export function fmtPct(p) {
  if (p == null) return "";
  return p >= 10 ? `${Math.round(p)}%` : `${Math.round(p * 10) / 10}%`;
}

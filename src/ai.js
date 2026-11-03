// One AI tool over the process tree. Rows carry the image name only, never the
// command line or a token parsed from it: argv can hold secrets, and this tree
// includes tedi.ai-usage's own curl with a bearer token on its command line.

import { ctx, state } from "./runtime.js";
import { buildSnapshot, fmtBytes, isTediOwn, ownRss, sample } from "./procs.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** A reading newer than this is reused: a CPU delta over a few ms is only noise. */
const FRESH_MS = 5_000;

/** @type {import("../tedi").ContributedAiTool} */
const TOOL = {
  name: "process_monitor",
  description:
    "TEDI's process tree: the app, its terminals and all they started. list: top N by memory or CPU, plus totals. kill: end one pid from that tree, needs confirm: true, refuses TEDI's own processes.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "kill"] },
      sort: { type: "string", enum: ["memory", "cpu"] },
      limit: { type: "integer", description: "list: max rows, up to 50." },
      pid: { type: "integer" },
      confirm: { type: "boolean" },
    },
    required: ["action"],
  },
  // Advisory: the host forces approval on the in-app agent regardless.
  approval: "needsApproval",
};

const isWindows = () => ctx?.os?.platform === "windows";

/** One on-demand read. Not stored: `state.prev` stays the poll's own CPU baseline. */
async function freshSnapshot() {
  const at = Date.now();
  const rows = await sample(isWindows());
  return buildSnapshot(rows, state.prev, at, navigator.hardwareConcurrency || 1);
}

/** @param {Record<string, unknown>} args */
async function list(args) {
  let snap = state.last;
  if (!snap || Date.now() - snap.at > FRESH_MS) {
    try {
      snap = await freshSnapshot();
    } catch (err) {
      if (!snap) return { note: `No process sample yet: ${err instanceof Error ? err.message : err}` };
    }
  }
  if (!snap.nodes.length) return { note: "No TEDI processes were found in the process table." };

  const byCpu = args.sort === "cpu";
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit)) || DEFAULT_LIMIT));
  const top = [...snap.nodes]
    .sort((a, b) => (byCpu ? (b.cpuPct ?? -1) - (a.cpuPct ?? -1) : 0) || b.rss - a.rss)
    .slice(0, limit)
    .map((n) => ({
      pid: n.pid,
      ppid: n.ppid,
      name: n.name,
      role: n.role,
      memory: fmtBytes(n.rss),
      cpuPct: n.cpuPct,
    }));
  return {
    ageSeconds: Math.round((Date.now() - snap.at) / 1000),
    ...(snap.cpuPct == null ? { note: "CPU needs two samples: call again in a few seconds." } : {}),
    totals: {
      processes: snap.count,
      memory: fmtBytes(snap.rss),
      tediOwnMemory: fmtBytes(ownRss(snap.nodes)),
      cpuPct: snap.cpuPct,
      agents: snap.agents.length,
    },
    sortedBy: byCpu ? "cpu" : "memory",
    top,
  };
}

/** @param {Record<string, unknown>} args */
async function kill(args) {
  // This number goes into a shell command, so nothing but a plain integer passes.
  const pid = Number(args.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { error: "kill needs a positive integer pid." };

  // Always a fresh read: Windows recycles pids, so a cached row may name a stranger.
  const target = (await freshSnapshot()).nodes.find((n) => n.pid === pid);
  if (!target) return { error: `Pid ${pid} is not in TEDI's process tree, so it was not killed.` };
  if (isTediOwn(target)) {
    return { error: `Refused: pid ${pid} (${target.name}, ${target.role}) is part of TEDI itself.` };
  }
  if (args.confirm !== true) {
    return { error: `Not killed: pass confirm: true to kill pid ${pid} (${target.name}).` };
  }

  // No /T: only the named pid, so a tree kill cannot reach a nested TEDI below it.
  const command = isWindows() ? `taskkill /F /PID ${pid}` : `kill ${pid}`;
  const out = await ctx?.invoke("shell_run_command", { command, cwd: null, timeoutSecs: 10 });
  if (out?.exit_code !== 0) {
    const why = String(out?.stderr ?? "").trim().split(/\r?\n/)[0];
    return { error: `Could not kill pid ${pid} (${target.name}): ${why || "the command failed"}` };
  }
  return { killed: pid, name: target.name };
}

/** @param {Record<string, unknown>} args */
function handler(args) {
  if (args.action === "list") return list(args);
  if (args.action === "kill") return kill(args);
  return { error: `Unknown action "${args.action}". Use "list" or "kill".` };
}

export function registerAiTool() {
  if (typeof ctx?.contribute?.aiTools !== "function") return;
  ctx.contribute.aiTools([TOOL]);
  ctx.registerAiToolHandler(TOOL.name, handler);
}

// The streaming sampler: one long-lived shell that prints a framed block per
// second, read back through the host's background-process log buffer.
//
// It exists for one measured reason. On Windows every freshly spawned process
// pays ~600 ms before it produces a row - PowerShell start-up plus WMI's first
// connection - and `tasklist` is no cheaper, so a one-shot poll fast enough to
// draw a chart would burn a third of a core. Inside a shell that is already
// running, the same work is ~170 ms for the full table and ~50 ms for the
// numbers-only one, so a one-second cadence costs about 6% of one core.
//
// Everything here is an OPTIMISATION, never a dependency: if the spawn is
// refused, the shell is missing or the stream dies, `index.js` falls back to
// the one-shot sampler and the pane keeps working, just less often.

import { ctx, state } from "./runtime.js";
import { WIN_LOOP, UNIX_LOOP } from "./procs.js";

/** How often to drain the log buffer. The shell writes a block a second. */
const READ_MS = 1000;
/** A block that never closes means a wedged shell; give up and fall back. */
const MAX_TAIL = 4 * 1024 * 1024;

/**
 * Start the sampler. Resolves false when it could not be started, which is a
 * normal outcome (missing permission, no PowerShell) and not an error.
 * @param {boolean} isWindows
 * @param {(kind: "F" | "L", payload: string) => void} onBlock
 * @returns {Promise<boolean>}
 */
export async function start(isWindows, onBlock) {
  if (state.stream) return true;
  // `pwsh` first for the faster engine, then Windows PowerShell, which is
  // always present. Unix pins `/bin/sh`: the loop is POSIX, and going through
  // the user's login shell would hand it to fish, whose syntax is not.
  const candidates = isWindows
    ? [
        { program: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", WIN_LOOP] },
        { program: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", WIN_LOOP] },
      ]
    : [{ program: "/bin/sh", args: ["-c", UNIX_LOOP] }];

  for (const { program, args } of candidates) {
    try {
      const handle = await ctx?.invoke("shell_bg_spawn_direct", { program, args, cwd: null });
      if (typeof handle !== "number") continue;
      state.stream = { handle, offset: 0, tail: "", timer: null, onBlock };
      state.stream.timer = setInterval(() => void read(), READ_MS);
      return true;
    } catch (err) {
      ctx?.logger?.info?.(`stream via ${program} unavailable`, err);
    }
  }
  return false;
}

/** Stop and reap the sampler. Safe to call when it was never started. */
export async function stop() {
  const s = state.stream;
  if (!s) return;
  state.stream = null;
  if (s.timer) clearInterval(s.timer);
  try {
    await ctx?.invoke("shell_bg_kill", { handle: s.handle });
    await ctx?.invoke("shell_bg_remove", { handle: s.handle });
  } catch (err) {
    ctx?.logger?.info?.("stream teardown failed", err);
  }
}

async function read() {
  const s = state.stream;
  if (!s || !state.active) return;
  let res;
  try {
    res = await ctx?.invoke("shell_bg_logs", { handle: s.handle, sinceOffset: s.offset });
  } catch (err) {
    ctx?.logger?.warn?.("stream read failed", err);
    void fail();
    return;
  }
  if (!res || state.stream !== s) return;
  s.offset = res.next_offset;
  // `dropped` means the ring buffer lapped us (the app was suspended, say).
  // The partial block in `tail` is now unreliable, so start clean.
  s.tail = (res.dropped > 0 ? "" : s.tail) + String(res.bytes ?? "");
  if (s.tail.length > MAX_TAIL) s.tail = "";

  const { blocks, rest } = takeBlocks(s.tail);
  s.tail = rest;
  for (const b of latest(blocks)) {
    try {
      s.onBlock(b.kind, b.payload);
    } catch (err) {
      ctx?.logger?.warn?.("stream block rejected", err);
    }
  }
  if (res.exited) void fail();
}

/** The shell died (or was never healthy). Tear down and let the caller's
 *  fallback poll take over; `state.streamDead` is latched so we do not respawn
 *  a shell that is failing for a reason we cannot fix. */
async function fail() {
  state.streamDead = true;
  await stop();
}

/**
 * Split framed output into complete blocks, returning whatever is left over.
 * A block is `#F` or `#L`, its payload lines, then `#E`.
 * @param {string} text
 * @returns {{ blocks: { kind: "F" | "L", payload: string }[], rest: string }}
 */
export function takeBlocks(text) {
  /** @type {{ kind: "F" | "L", payload: string }[]} */
  const blocks = [];
  let rest = text;
  for (;;) {
    const m = /(?:^|\n)#([FL])\r?\n/.exec(rest);
    if (!m) break;
    const bodyStart = m.index + m[0].length;
    const end = rest.indexOf("\n#E", bodyStart - 1);
    if (end < 0) {
      // Keep the partial block (and drop anything before it, which is either
      // already-applied output or garbage).
      rest = rest.slice(m.index);
      return { blocks, rest };
    }
    blocks.push({
      kind: /** @type {"F" | "L"} */ (m[1]),
      payload: rest.slice(bodyStart, end + 1),
    });
    rest = rest.slice(end + 3);
  }
  // Nothing opened: keep only a possible partial marker at the very end.
  return { blocks, rest: rest.slice(-3) };
}

/**
 * At most two blocks are worth applying from one read: the newest full one
 * (structure) and the newest light one after it (numbers). Anything older is
 * a snapshot we would immediately overwrite.
 * @param {{ kind: "F" | "L", payload: string }[]} blocks
 */
export function latest(blocks) {
  let fullAt = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "F") {
      fullAt = i;
      break;
    }
  }
  /** @type {{ kind: "F" | "L", payload: string }[]} */
  const out = [];
  if (fullAt >= 0) out.push(blocks[fullAt]);
  for (let i = blocks.length - 1; i > fullAt; i--) {
    if (blocks[i].kind === "L") {
      out.push(blocks[i]);
      break;
    }
  }
  return out;
}

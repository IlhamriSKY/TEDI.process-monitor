# TEDI Process Monitor

A task manager scoped to [TEDI](https://tedi.ilhamriski.com/). The status bar
carries the total memory of everything the app owns, and one click opens the
short version of where it went: **TEDI itself, and the terminals you opened.**

Nothing is hidden, only summed. The WebView2 children, the extension sidecars,
each ConPTY's conhost and everything a shell went on to start are added to the
row that owns them, so a terminal weighs what the shell and its whole subtree
weigh together and the column still adds up to the entire tree. That is the
number worth reading: a shell showing 2.0G is telling you the agent inside it
is holding two gigabytes, which is the question you opened the pane with.

AI CLIs attached to a terminal, [Claude Code](https://claude.com/claude-code),
[Codex](https://openai.com/codex), Gemini, opencode and the rest, badge the
terminal they are running in and name it, so you can see at a glance which of
five identical `pwsh` rows is the expensive one.

<p align="center">
  <img src="logo.png" alt="Process Monitor" width="128" />
</p>

## Install

1. Open **Settings → Extensions** in TEDI.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.process-monitor` and click **Review → Install**.

The meter appears at the bottom-right, to the right of the AI usage meters.

To install a local build instead, run `npm install && npm run build`, zip
`manifest.json`, `extension.js` and `logo.png` at the root of the archive, and
pick it from the **From .zip** tab. Re-installing the same id replaces the
existing copy, so that is also how a local build upgrades.

## Update

In **Settings → Extensions**, click **Check updates** on this extension's card.
If a new release exists, click **Update** to reinstall in place.

## What you get

- A **status-bar meter**: total memory of every process TEDI owns, drawn as a
  share of the machine's RAM. Hovering adds the same pixel trend the pane draws
  plus CPU and memory, and nothing else - the per-process list is what the click
  is for. It sits immediately right of the AI usage meters: the
  bar groups extensions that publish a meter ahead of the icon-only ones, so
  the readouts you scan are not split by the state lights you glance at.
- A **pane** (click the meter, `Mod+Alt+M`, or the command palette) with a
  three-minute memory chart over the tree, and under it one row for TEDI, one
  for its PTY daemon, and one for each terminal you opened. A row carries the
  memory and CPU of everything folded into it, a `+N` saying how many processes
  that is, and the command line plus that count on hover.

The chart is drawn on the same pixel grid the status bar uses - 4 px cells with
a 2 px gap, filled in the accent over an empty track, the vocabulary of the
host's `PixelBar` - so the chart and the meters beside it read as one component
rather than two charting styles. Each column is a slice of time holding the
PEAK memory in it (a monitor that hides a spike between two samples is not
doing its job), and the top cell of each column is lit brighter so the trend
line is readable across the grid.

Its vertical axis fits the window rather than starting at zero, and labels its
own peak and low, because against 32 GB of installed RAM every real change is a
flat line. A trace that is genuinely steady is held to a 2% band so noise is not
magnified into a mountain range.

## How it works

One shell call reads the OS process table, the same table Task Manager and `ps`
read:

| Platform          | Source                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**       | `Get-CimInstance Win32_Process`, for pid, parent pid, image name, command line, working set and CPU time. `tasklist` reports no parent pid and `wmic` is gone from Windows 11 24H2, so CIM is the only complete answer.                       |
| **macOS / Linux** | `ps -e -w -w -o pid=,ppid=,rss=,time=,args=`. macOS documents `-e` as identical to `-A` (there it is `-E` that dumps the environment), and the repeated `-w` stops procps clipping the arguments to 80 columns when stdout is not a terminal. |

The tree is rooted at every live process running TEDI's own binary. That is two
things, not one: the window, and the PTY daemon, which is the same executable
re-launched with `--pty-daemon`. The daemon deliberately outlives the window
that spawned it, so after a restart its parent is a pid that no longer exists
and walking down from the window alone would miss every terminal in the app.
Everything below either root is included, which is how a `claude` session, the
language server it started and the `cargo` it is running all end up in the same
list.

A pid is only accepted as a parent if it is still alive **and** started no later
than its child. Windows recycles pids aggressively, and without that second test
a long-dead parent's number can hand a stranger's subtree to the app.

CPU is a delta between two samples, normalised against every core, so the column
sums to the share of the machine TEDI is using, the same way Task Manager
counts. It is blank on the first sample, because a cumulative counter is not a
percentage until there is something to subtract.

### Two sampling modes, and why

Reading the process table is cheap; the process you spawn to read it is not. On
Windows a freshly spawned reader costs about **600 ms of a core before it
produces a single row** - PowerShell start-up plus WMI's first connection - and
`tasklist` measures no cheaper. So there are two modes:

| When                                | How                                                                                                            | Cost (measured, Windows)                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A pane is open and visible          | One long-lived shell prints a framed block every second: a numbers-only block, and the full table every eighth | **~6% of one core**, and the shell's own ~130 MB |
| Meter only, or the window is hidden | One-shot every 30 s, or not at all                                                                             | ~0.6-1.1 s of a core per sample                  |

The live sampler is an optimisation, never a dependency: if the spawn is
refused, PowerShell is missing or the stream dies, the one-shot takes over at
5 s and the pane keeps working. It is killed the moment the last pane closes or
the window is hidden.

Because that live sampler is one stable process rather than a new one per poll,
and because on Windows it is a PowerShell (~83 MB of that is PowerShell merely
existing), it is **counted in the total** - folded, like every other helper,
into TEDI's own row. Hiding it would understate the very number this pane
reports. The one-shot sampler is dropped instead, for the opposite reason: it is
a different process every time, so counting it would make the total flicker by
whatever a PowerShell costs on the polls it happens to land on.

```
67 processes · 5.2G · CPU 2.9% · 3 agents                    [Refresh]
5.2G                                       peak 5.5G · low 4.9G
· · · · · · · · · · · · · ■ ■ · · · · · · · · · · · · · · · · ·
· · · · · · · · · · · ■ ■ ▩ ▩ ■ · · · · · · · · · · · · · · · ·
· · · · · · ■ ■ ■ ■ ■ ▩ ▩ ▩ ▩ ▩ ■ ■ · · · · · · · · ■ ■ ■ ■ ■ ■
■ ■ ■ ■ ■ ■ ▩ ▩ ▩ ▩ ▩ ▩ ▩ ▩ ▩ ▩ ▩ ▩ ■ ■ ■ ■ ■ ■ ■ ■ ▩ ▩ ▩ ▩ ▩ ▩
last 3 min

Process                          PID    CPU   Memory
TEDIApp                +11     22708   1.1%     846M
  TEDIApp  pty daemon           22804   0.2%      45M
    pwsh  AGENT  claude  +10     1840   0.5%     1.2G
    pwsh  AGENT  claude  +16    18528   0.5%     1.2G
    pwsh  AGENT  claude  +22     2856   0.6%     2.0G
```

Five rows for sixty-seven processes, and they still add up to 5.2G. The `+11`
on the window is its WebView2 children and the extension sidecars; the `+22` on
the last shell is one Claude Code and the twenty-one processes it started.

## Permissions

| Permission                                                                             | Why                                                                                                        |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `invoke:shell_run_command`                                                             | The one-shot process-table read.                                                                           |
| `invoke:shell_bg_spawn_direct` + `shell_bg_logs` + `shell_bg_kill` + `shell_bg_remove` | The live sampler while a pane is open: spawn it (argv only, no shell), drain its output, stop and reap it. |
| `statusbar:write`                                                                      | The meter.                                                                                                 |
| `panels:register` + `tabs:open`                                                        | The Processes pane.                                                                                        |

## Platform notes

|                 | Windows                                | macOS                                                                                                                                                                     | Linux                     |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Process table   | CIM                                    | `ps`                                                                                                                                                                      | `ps`                      |
| Live sampler    | `pwsh`, else `powershell`              | `/bin/sh`                                                                                                                                                                 | `/bin/sh`                 |
| Total RAM       | `Win32_ComputerSystem`                 | `sysctl hw.memsize`                                                                                                                                                       | `/proc/meminfo`           |
| pid-reuse guard | yes (`CreationDate`)                   | not needed                                                                                                                                                                | not needed                |
| Webview weight  | WebView2 children fold into TEDI's row | **absent**: WKWebView content processes are launchd's children, not the app's, so they cannot honestly be attributed here, and TEDI's row is lighter by exactly that much | WebKitGTK helpers fold in |

The live sampler pins `/bin/sh` rather than the login shell, because the loop
is POSIX and fish is not.

## Privacy

Nothing leaves the machine and nothing is written. The extension only reads the
process table, and it never kills, suspends or signals anything: the row is a
readout, not a control. Command lines are shown in a row's tooltip and are
truncated at 240 characters.

## Development

```bash
npm install
npm run build      # bundles src/ -> extension.js
npm test           # the parser and the tree walk, against a real process table
npm run typecheck  # tsc against tedi.d.ts
```

`src/procs.js` is pure apart from the one shell call, which is what makes the
tree walk testable: `src/procs.test.mjs` runs it over a trimmed copy of a real
Windows process table and asserts on membership, roles, depth, labels and the
CPU delta.

## License

Apache-2.0

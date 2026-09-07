# Changelog

## 0.1.2

- **The pane is TEDI and the terminals you opened, and nothing else.** Sixty-
  seven rows was a wall, and most of it was somebody's plumbing: WebView2
  children, extension sidecars, a conhost per ConPTY, and the whole tool tree an
  agent starts under itself. Those are gone as rows and **summed into the row
  that owns them**, so nothing is hidden - a terminal now weighs what the shell
  and everything it started weigh together, the column still adds up to the
  entire tree, and a `+N` on each row says how many processes it is speaking
  for. Sixty-seven processes read as five rows that still total 5.2G.
- **A terminal says what is running in it.** Five identical `pwsh` rows told you
  nothing; the row now carries the agent's name, or the heaviest thing under it,
  and wears the `agent` badge when an AI CLI is attached. Which of them is
  holding two gigabytes is the whole question, and it is now the first thing on
  the row.
- **The `live` / `every 5s` indicator is gone.** It reported which sampler was
  running, which is the extension's business and never the reader's.
- **The hover bubble follows the cursor instead of the row.** Rows are 21 px
  tall in a list that scrolls, so a bubble hung off the row's box landed over
  its neighbours and read as belonging to one of them. It now opens just above
  the pointer, flipping below only when there is no room above.
- **Fixed: a process exiting mid-tree left a hole in it.** A numbers-only block
  drops the process that exited but keeps its descendants, which are alive and
  still cost memory. They were left pointing at a dead pid, so the tree had a
  hole in it and anything walking parentage fell through: before this release
  that showed as a row indented under nothing, and with rows now summing their
  subtrees it would have quietly dropped up to a gigabyte for the ~7 seconds
  until the next full block. Survivors are re-parented onto the exited
  process's own parent, and the whole subtree moves up with it. Seven of every
  eight blocks are numbers-only ones, so this is the path the pane spends its
  life on, and the tests now cover it.

## 0.1.1

- **Activation no longer holds TEDI's boot for three and a half seconds.** The
  first sample reads total RAM and enumerates every process, both of which are
  shell spawns, and `activate` is awaited by the extension loader - so the whole
  app waited on them and the host logged "move slow work off the activate path".
  The meter is drawn before any of it now and fills itself in behind the reading
  it already shows.

## 0.1.0

First release.

- Status-bar meter: total memory of every process TEDI owns, as a share of the
  machine's RAM, with process count, live CPU and attached agents in the
  tooltip. Sits to the right of the AI usage meters.
- Processes pane (click the meter, `Mod+Alt+M`, or the command palette): the
  whole tree, indented by parentage, with per-process CPU and memory and the
  full command line on hover.
- The tree is rooted at every live process running TEDI's binary, which is both
  the window and the PTY daemon, so terminals still appear after the daemon has
  outlived the window that spawned it.
- Attached AI CLIs (Claude Code, Codex, Gemini, opencode, Copilot, Grok, aider,
  goose, cursor-agent and friends) are badged as agents, whether they run as
  their own binary or as `node <somewhere>/cli.js`.
- A pid is only accepted as a parent if it is alive and started no later than
  its child, so a recycled pid cannot hand a stranger's subtree to the app.
- A three-minute memory chart over the tree, auto-fitted to its own window and
  labelled with the peak and the low, so a climb or a spike is visible against
  a machine whose total RAM would flatten it. Drawn on the host's pixel grid
  (4 px cells, 2 px gaps, an empty track under lit columns, brighter top cell)
  so it shares a vocabulary with the `PixelBar` meters in the status bar rather
  than looking like a charting library dropped into the pane.
- Two sampling modes: a live sampler (one long-lived shell, a framed block a
  second, ~6% of one core) while a pane is open and visible, and a one-shot
  every 30 seconds otherwise. Measured on Windows, where any freshly spawned
  reader costs ~600 ms of a core before it produces a row. The live sampler is
  an optimisation with a fallback, never a dependency, and is killed when the
  last pane closes or the window is hidden.
- The live sampler is shown in the tree and counted in the total, labelled
  `process monitor`. It costs real memory and hiding it would understate the
  number this pane exists to report.
- Rows are updated in place while the process set is unchanged, so hovering a
  row for its command line survives a one-second refresh.
- Row hover uses TEDI's own tooltip styling (the `--popover` surface, a 1px
  ring, 11px text, a 200 ms delay and 6 px offset) instead of the native `title`
  attribute, which rendered as a Windows tooltip in the middle of the app.
- The meter sits immediately right of the AI usage meters. Needs the host change
  below: the status bar used to order extension items alphabetically by id,
  which left this one behind the browser and Discord icons.

### Host requirement

`engines.tedi >= 0.4.7` still installs and runs everywhere, but the placement
above needs a TEDI whose status bar sorts metered extensions before icon-only
ones (`orderStatusItems` in `src/modules/extensions/registries.ts`). On an older
host the meter simply falls back to alphabetical placement.

---
name: verify-thinking-digest
description: "Verify the thinking-digest plugin for the pi coding agent on its real surface: a terminal TUI driven through tmux. Use when proving the hidden-thinking line, its one-line digest, the hide/digest/latest mode switch, history refresh after a mode change, or /td-status and /td-mode behavior, or when any change to thinking-digest/index.ts needs on-device acceptance."
---

# Verify thinking-digest

What is being verified is the user visible behavior of the `thinking-digest` extension inside a real `pi` coding agent TUI session. The surface is a terminal TUI. The harness is tmux with `send-keys` and `capture-pane -p`.

The plugin owns one line: the hidden-thinking label that pi draws when `hideThinkingBlock: true`. This skill proves what that line says in each of the three modes, and that a mode switch repaints history already on screen.

## Why the drive replays a session instead of prompting a model

Free models on this machine do not reliably emit `thinking` blocks: two live probes (`opencode-zen-free/deepseek-v4.1-flash-free` and `magpie/auto/deepseek-v4.1-flash`) produced zero `"type":"thinking"` entries in the session file, so the hidden line never existed and the run proved nothing.

`mk-session.py` writes a session file with real `thinking` blocks and replays it through `pi --session <path>`. No model call, no token cost, and the digest text is deterministic. The anchors are:

- turn 1 → `结论是第一题的答案是十一。`
- turn 2 → `结论是第二题的答案是二十二。`
- `--rounds` → `第N轮第K段思考…`（三轮，每轮 1/2/3 段）
- `--agentic` → `第N轮第K次思考…`（每条助手消息前插一条 `thinking-digest-timing`，父节点是它，因为 pi 先 `message_end` 后写消息）（两轮用户提问，每轮内 3/2 条「思考+工具调用」的助手消息），每条助手消息后带一条 `thinking-digest-timing`（第 1 轮合计 1s、第 2 轮合计 2s）

The live-model path stays available as a secondary check: if a model does emit thinking, the same assertions hold, with the elapsed segment present (`Thought for <N>s (…)`) instead of absent (`Thought (…)`).

## Launch

One drive runs in its own tmux session and its own config directory, so it never touches the operator's `~/.pi/agent` or its settings lock.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)/thinking-digest/skills/verify-thinking-digest"
./verify.sh launch
```

`launch` does all of the following and is idempotent per run id:

- builds `/tmp/td-verify-agent` (`PI_CODING_AGENT_DIR`) with a minimal `settings.json` (`packages: []`, `hideThinkingBlock: true`), plus copies of `keybindings.json`, `auth.json`, `models.json`;
- symlinks `thinking-digest/index.ts` into that directory's `extensions/`;
- generates `artifacts/<RUN_ID>/session.jsonl` via `mk-session.py`;
- starts `pi --session <that file> --no-context-files --no-skills --no-prompt-templates --no-mcp` inside tmux at 140×42;
- captures `launch.log` and requires the extension to appear under `[Extensions]`.

Ready means the transcript already shows the replayed turns and `[Extensions]` lists `thinking-digest.ts`. A `Lock file is already being held` line means a stale pi holds the isolated settings file; remove that directory and relaunch.

## Doctor

```bash
./verify.sh doctor
```

Sends `/td-status` and asserts both halves of "worth driving":

- `已接管（候选 N 个，已补丁 N 个）` — the patch bound to a runtime class;
- `updateContent 调用 [1-9][0-9]* 次` — the patched method actually ran (a bound patch that never fires looks identical to a working one on screen).

Evidence lands in `doctor.log`.

## Drive

Default full pass:

```bash
./verify.sh all   # prose → scope → turnscope → rebind → doctor → digest → latest → fold → agentic → timed → hide → restore
```

| Command | Sends | Asserts |
|---|---|---|
| `./verify.sh digest` | `/td-mode digest` | both turns show `Thought (Ctrl+T to expand) · <anchor>`, exactly one line each |
| `./verify.sh latest` | `/td-mode latest` | **every** round keeps its own line: 2 rounds → exactly 2 lines, both anchors present. A round's line must never wipe another round's line |
| `./verify.sh fold` | replay 3 rounds with 1/2/3 thinking runs | digest: 6 lines, each run its own digest; latest: exactly 3 lines (one per round), the multi-run round reports its own `(N runs)` |
| `./verify.sh agentic` | replay 2 user turns, 3 and 2 assistant iterations each | latest: exactly **2** lines (one per user turn), each reporting its turn's run count; no line per assistant iteration |
| `./verify.sh timed` | replay a session that already carries `thinking-digest-timing` entries | latest: `Thought for 1s (3 runs)` and `Thought for 2s (2 runs)`, i.e. the duration survives a restart instead of degrading to `Thought (N runs)` |
| `./verify.sh restart` | live model turn, kill, relaunch the same session | the line reports the same `Thought for Ns` before and after; the session file contains a `thinking-digest-timing` entry |
| `./verify.sh rebind` | none (node probe) | replays pi's in-process order (render history, then bind extensions): after `session_start` the already-rendered history is repainted and gains its duration |
| `./verify.sh resume` | real `/resume` in one running pi | switching into a session that carries timing entries still shows `Thought for 1s (3 runs)`; the selector is driven by typing a filter, not arrow keys |
| `./verify.sh hide` | `/td-mode hide` | zero `Thought (…)` lines |
| `./verify.sh restore` | `/td-mode digest` | two lines come back |
| `./verify.sh stream` | real model + long reasoning prompt | two live frames (braille + `Thinking Ns`), settled line `Thought for Ns`, process alive |
| `./verify.sh shortcut` | tmux `C-S-k` | best effort; see Gotchas |
| `./verify.sh interleave` | replay interleaved fixture | non-thinking prose A/B/C around thinking runs all visible (master-reported 2026-11-11 regression surface) |
| `./verify.sh prose` | none (node probe) | a message with **no** thinking blocks keeps its prose even when the prose contains `…` and the host label was cleared to `""` |
| `./verify.sh scope` | none (node probe) | `latest` folds **one round**, not the session: a 3-run message reports `(3 runs)`, and the next 1-run message does not inherit the session total |
| `./verify.sh turnscope` | none (node probe) | within one user turn, the line moves to the newest assistant message and the previous message's line is repainted away; a following turn does not touch the earlier turn's line |

The mode commands go through `/td-mode`, not the hotkey, because tmux without `extended-keys` cannot deliver `Ctrl+Shift+K` (see Gotchas).

### When `stream` runs automatically

`stream` makes one real model call (about $0.002 on `auto/deepseek-v4.1-flash`), so it never runs by default:

- `./verify.sh all` = doctor → digest → latest → hide → restore. **No `stream`.**
- `TD_LIVE=1 ./verify.sh all` cleans up after the replay steps, then appends `stream`.

Run `stream` by hand whenever a change touches the streaming path: the `updateContent` streaming branch, the spinner frame, live elapsed time, or anything that triggers repaints. The replay fixture cannot cover those, because every replayed message is already settled — that is exactly how the `setWidget` crash slipped past the first acceptance run.

## Evidence

Every capture is appended to `artifacts/<RUN_ID>/<step>.log`; `artifacts/.current-run` names the active run. `session.jsonl` and `session-notes.txt` record the exact fixture, so a later reader can re-derive what the screen was supposed to show.

A proof is `digest.log` + `latest.log` + `hide.log` + `restore.log` from one RUN_ID, all passing, plus a `doctor.log` from the same session. A screenshot of one mode alone is not a proof of the switch.

`stream` writes its own set: `stream-launch.log`, `stream-frame-a.log`, `stream-frame-b.log`, `stream-done.log`. Every one of them is scanned by `crash_guard`, which fails the run when a runtime exception stack (`TypeError`, `child.render is not a function`, stack overflow) shows up — a crash otherwise looks like "the line is missing".

## Cleanup

```bash
./verify.sh cleanup
```

Kills the tmux session by its run id, deletes the isolated agent dir, and verifies `artifacts/<RUN_ID>` still exists. Evidence is never removed. `TD_KEEP_AGENT=1 ./verify.sh cleanup` keeps the isolated dir for post-mortem.

## Helpers

- `verify.sh` — launch, doctor, per-mode drives, shortcut probe, cleanup, help. Every subcommand is listed by `./verify.sh help`.
- `mk-session.py --out <path> [--turns 1|2]` — writes the deterministic replay session; prints its anchors.

## Gotchas

- **Free models may emit no thinking at all.** Both `opencode-zen-free/deepseek-v4.1-flash-free` and `magpie/auto/deepseek-v4.1-flash` returned zero thinking blocks on a live probe, even with thinking level `high`. Use the replay session for acceptance; a live run that shows no line proves nothing about the plugin.
- **`/td-status` showing `托管组件 0` right after a live turn** means no thinking block arrived, not that the patch failed. Check the session file for `"type":"thinking"` before blaming the plugin.
- **tmux folds `Ctrl+Shift+K` into `Ctrl+K` without `extended-keys`.** `./verify.sh shortcut` therefore does not fail the run; verify the hotkey in a real terminal, or add `set -g extended-keys on` to `~/.tmux.conf` and restart tmux.
- **Never drive repaints with `ctx.ui.setWidget(key, () => [])`.** pi treats the factory's return value as one child of its layout stack; an empty array there makes the next frame throw `child.render is not a function` and kills the process. This plugin therefore has no timer and no repaint pump: the streaming frame advances on each `updateContent` (one per delta), which the host repaints anyway.
- **Hiding must not splice the host's `children`.** Other extensions (pi-pretty grouping, tool-tail-fold's render wrapper) read that array by index and cache it across frames. Clearing the text and setting the preceding Spacer to 0 lines hides the row without changing the array length.
- **Interleaved fixtures need a proper parentId chain.** Every assistant entry must chain `user → assistant`; an assistant entry with `parentId: null` is silently skipped by the replay renderer and reads as "text missing". The `--interleaved` fixture in `mk-session.py` (text → thinking → text → thinking → text, one message) builds the chain correctly; `./verify.sh interleave` asserts all three prose blocks stay visible around the thinking runs.
- **The hidden-label placeholder must be unmatchable by prose.** `pi-omp-theme` clears `hiddenThinkingLabel` to `""` (its `messages.hideThinkingLabel` default is true), and a `""` label makes pi skip building the row entirely. The extension fills a sentinel instead. The original placeholder was `…`, which prose carries constantly (ellipses, truncated paths), so `applyLine` matched ordinary prose and `removeRow` blanked the whole message. `./verify.sh prose` pins this: a no-thinking message whose prose contains `…` must survive with the label forced to `""`.
- **`applyLine` never runs on a message without thinking blocks.** pi draws no row for such a message, so the only thing a match could hit is prose. The `hasThinking` guard is what keeps a stray label from eating it.
- **Fold scope is one user turn, not one assistant message.** A real turn is "thinking + tool call" repeated: one assistant message per iteration. Folding per message therefore draws one line per tool loop (master reported 11 lines for a single turn on 2026-11-11). The turn boundary comes from `ctx.sessionManager.getEntries()`: the nearest preceding `user` entry; the line lives on the last assistant message *with thinking* in that turn, and reports that turn's run count and elapsed.
- **In-process session switch renders before extensions bind.** `pi` binds extensions after rendering the restored transcript on `/resume`, the session selector and fork, so the timing entries and the turn index are not available to that first render. `session_start` seeds both and then repaints the components the pre-bind render already created (`liveComponents` must survive the session start, not be cleared there). Without the repaint the line stays at `Thought (N runs)` until a mode switch. `./verify.sh rebind` pins the ordering from a probe, `./verify.sh resume` pins it on the real selector.
- **Timing is recorded by mode-independent code.** `applyLine` calls `trackTiming` before any mode branch, because `hide` returns early from `buildLine`; recording inside `buildLine` alone would leave a hidden-mode turn with no measurement and nothing to persist.
- **Elapsed time only survives if it is written into the session.** `timings` is an in-process map, cleared on session start, so a restored transcript used to fall back to `Thought (N runs)` with no duration (master reported 2026-11-11 right after the fold work). The extension now appends a `custom` session entry `thinking-digest-timing` (`{ts, ms}`) on `message_end`, once per settled message, and seeds `timings` from those entries on session start. `./verify.sh timed` pins the restore path from a fixture, `./verify.sh restart` pins the live write-then-reopen path. Sessions recorded before this change carry no entries and still show no duration; that is missing data, not a regression.
- **The line has to be taken away, not just skipped.** When a newer assistant message in the same turn becomes the carrier, the older component already drew its line and nothing repaints it. `ensureTurnFolds()` records the carriers of the previous build and queues a microtask that repaints exactly those components; without it the old line stays on screen and the fold looks broken again. `./verify.sh turnscope` pins this path (no tmux, no model).
- **Fold scope is one round (one assistant message), never the session.** `latest` used to compare each message's timestamp against a session-global `latestTimestamp`, so every older round's line was deleted and the whole transcript kept a single line. The same mindset made it report session-cumulative duration and `(N runs)`. Both are per message now: `verify.sh latest` pins one line per round, `verify.sh fold` pins one line per round plus per-round run counts, and `verify.sh scope` pins the run count against session accumulation (replay carries no timing, so the `(N runs)` tag only exists in live streaming).
- **Replayed history has no in-process elapsed time.** The line renders `Thought (Ctrl+T to expand) · …` without `Ns`. Do not assert a duration on replayed turns.
- **The isolated agent dir loads no third-party extensions.** A real session also runs `pi-pretty` / `pi-omp-theme`; if a mode looks wrong only in the real environment, re-check with those packages enabled before blaming this plugin.
- **A mode switch must repaint history, not just new turns.** That is what `latest` and `restore` assert. If they pass but the operator still sees stale rows, the difference is the real environment (extra extensions patching the same component), not the replay fixture.
- **Do not assert a spinner frame.** Frames rotate every 33ms; assert the stable parts (`Thinking …` while streaming, `Thought … (Ctrl+T to expand) · …` once settled) and never a specific braille glyph.
- **The streaming frame is not covered by the replay fixture.** A replayed message is already settled, so the `<frame> Thinking Ns · <digest>` phase only appears with a live thinking model. The replay proves the settled line and the mode switch; it cannot prove the animation tick or the rewiring pump.
- **Never add an `artifacts` whole-directory ignore rule to `.gitignore`.** The file ignores `*.log` globally and re-includes evidence with `!…/artifacts/**/*.log`. A later rule naming the directory itself (`thinking-digest/skills/verify-thinking-digest/artifacts`) wins over that exception and makes every capture silently unstageable: `git add` exits 0 and commits nothing, so the run looks saved while no evidence reaches the repository. Commit `ffdb6b6` did exactly this and lost 7 hours of captures before it was found. Only `.current-run` may be ignored, and it already is. Check with `git check-ignore -v <a capture>` — an empty result means the path is stageable.

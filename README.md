# pi-thinking-digest

[![npm downloads](https://img.shields.io/npm/dw/pi-thinking-digest)](https://www.npmjs.com/package/pi-thinking-digest)
[![npm version](https://img.shields.io/npm/v/pi-thinking-digest)](https://www.npmjs.com/package/pi-thinking-digest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [pi](https://pi.dev) extension that takes over the hidden-thinking line: instead of a bare `Thinking…` label, you get a compact one-line digest with thinking duration and a content summary. Three display modes, switchable at runtime.

## Why

When `hideThinkingBlock: true`, pi renders a single label line per assistant message. The line is owned by whichever theme/extension draws it, they fight over it, and you learn nothing about what the model actually thought. This extension takes the line over completely: it measures duration itself, builds its own digest, and decides what to draw.

## Modes

Cycle with `/td-mode` or `Ctrl+Shift+K` (persisted in `~/.pi/agent/thinking-digest.json`):

| Mode | Behavior |
|---|---|
| `hide` | Fully hide the thinking line, including the label row |
| `digest` (default) | One line per assistant message: `Thought for 3s (Ctrl+T to expand) · summary` |
| `latest` | Fold a whole user turn: multiple thinking segments in one tool-loop round collapse into a single line |

## Install

```bash
pi install npm:pi-thinking-digest
```

## Notes

- Duration is wall-clock time from the first streamed thinking token to the end of the thinking segment, measured in-process. Restored history sessions have no start time, so old messages show `Thought (Ctrl+T to expand)` without a fabricated duration.
- The extension patches the runtime `AssistantMessageComponent` inside pi's actual TUI bundle (not the package export), so it works with themes like pi-pretty and pi-omp-theme instead of fighting them.
- Ctrl+T to expand thinking must be enabled in pi as usual; this extension only changes the collapsed line.

## License

MIT

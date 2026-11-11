# thinking-digest 功能地图

本目录是 `thinking-digest` 的验收源：每个键功能一个文件，驱动一律走 [`../verify.sh`](../verify.sh)。

## 功能索引

| Feature | 文件 | 一句话 |
|---|---|---|
| `hidden-line` | [digest-line.md](digest-line.md) | 隐藏思考时整行的构成：`thought <耗时> (Ctrl+T to expand) · 摘要` |
| `mode-switch` | [mode-switch.md](mode-switch.md) | `hide` / `digest` / `latest` 三模式切换，历史行必须跟着变 |
| `hide-mode` | [hide-mode.md](hide-mode.md) | 全隐藏：整行连同前面的空白 Spacer 一起删掉 |
| `latest-mode` | [latest-mode.md](latest-mode.md) | 只留最新一条思考行，旧的收掉 |
| `status-command` | [status-command.md](status-command.md) | `/td-status` 与 `/td-mode` 的诊断与切换 |

## 断言口径

- 行文锚点来自确定性回放会话（`mk-session.py`）：`结论是第一题的答案是十一。` / `结论是第二题的答案是二十二。`
- 回放消息没有本进程计时，行文是 `thought (Ctrl+T to expand) · …`；实时模型产生思考时才会出现 `thought <N>s (…)`。
- 只断言文字与行数，不断言颜色、具体动画帧、耗时数值。
- 完成态行文 `thought <N>s (Ctrl+T to expand) · <摘要>`；思考进行中是 `<动画帧> thought <N>s · <摘要>`（回放不覆盖这一段，见 SKILL.md 的 Gotchas）。
- `latest` 模式的时长是整场会话累计，段数 `(N runs)` 只在 N>1 时出现；回放没有本进程计时，行文退化为 `thought (Ctrl+T to expand) · <摘要>`。
- 任何一条断言失败，先打开 `artifacts/<RUN_ID>/<step>.log` 看屏幕原文，再判断是产品回归还是驱动问题。

## 驱动契约

每个 feature 文件固定四个 H2，顺序不变：

1. `Sub-features`：短 ID + 一行行为。
2. `How to get to it (user POV)`：用户能走到的入口。
3. `Driving it with tmux`：以 `Preconditions:` 开头，每条用户动作配一条精确命令与可观察结果。
4. `Gotchas`：会浪费或废掉一次验证的坑。

## 台账

每次运行在 [runs.md](runs.md) 追加一行：RUN_ID、覆盖 feature、证据目录、结论。红绿都记，不美化。

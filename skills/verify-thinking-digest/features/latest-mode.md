# 只留最近一条思考

`/td-mode latest` 时，只有时间戳最大的那条助手消息保留思考行，往上翻的旧思考行全部收掉。保留的那一行代表**整场会话的思考**：时长是全部有计时思考段的累计，括号里是本进程记录到的段数。判据是消息 `timestamp`：每次渲染推进全局最新值，并主动重绘旧组件让它们按新基准收行。

## Sub-features

- `latest-keep-newest` 最新一条显示 `thought <累计>s (<N> runs) (Ctrl+T to expand) · 摘要`：时长与段数覆盖整场会话内有计时的思考段。
- `latest-summary` 被收掉的旧思考不再单独占行，但它们的耗时仍计入累计；只有一段时省略 `(N runs)`。
- `latest-drop-old` 所有更早的思考行消失，包括切换前已经画在屏上的。
- `latest-new-turn` 新消息到达后，上一条自动降级为“旧”，行随之收掉。
- `latest-reversible` 切回 `digest` 后旧行恢复。
- `latest-no-digest-loss` 收行不影响正文与工具块。

## How to get to it (user POV)

- `/td-mode latest`；或按 Ctrl+Shift+K 循环到该模式。

## Driving it with tmux

Preconditions:

- `./verify.sh launch` 已就绪，回放会话含两轮带思考的问答。
- 当前模式为 `digest` 且两行都在（先跑 `./verify.sh digest`）。

- **切到 latest。** `tmux send-keys -t "$RUN_ID" "/td-mode latest" Enter`，等 2 秒。
- **抓屏。** `tmux capture-pane -t "$RUN_ID" -p | tee -a "$EVIDENCE_DIR/latest.log"`。
- **断言旧行 0 次。** 第一题锚点 `结论是第一题的答案是十一。` 不得出现。
- **断言最新行 1 次。** `thought ... · 结论是第二题的答案是二十二。` 恰好一行。
- **断言累计口径。** 回放消息没有本进程计时，行文应是 `thought (Ctrl+T to expand) · …`，不带秒数与 `runs`；若出现数字，说明把历史时间戳当成了计时起点。
- **断言正文未丢。** `11` 与 `22` 仍在屏上。
- **切回 digest。** 断言两行恢复（见 [mode-switch.md](mode-switch.md)）。
- **Proof.** `latest.log` 的“0 + 1”行数与 `restore.log` 的“2 行”成对出现。

## Gotchas

- 回放会话的两条消息时间戳相差 10 秒；若手工构造会话，确保第二条的时间戳更大，否则“最新”判反。
- 累计只统计本进程真正记过起点的思考段：恢复的旧会话、回放消息都不计入，所以回放永远不会出现 `Ns` 或 `(N runs)`。
- 只看新消息永远测不到这个 feature：收旧行依赖 `refreshAllComponents`，必须用屏幕上已有的旧行断言。
- 如果旧行没消失但新消息正常，先看 `/td-status` 的 `托管组件` 数量是否覆盖了两条消息。
- 真实会话里滚动可能触发重绘，让延迟收行看起来“事后才生效”；以切换后 2 秒内的抓屏为准。

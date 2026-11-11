# 隐藏思考行的整行文本

当 `hideThinkingBlock: true` 时，每条带思考的助手消息只显示一行。thinking-digest 接管这一行，写成 `thought <耗时> (Ctrl+T to expand) · <摘要>`：耗时来自本进程内的思考墙钟（取不到时省略），摘要取思考文本的末句实质句，最多 52 显示列。

## Sub-features

- `line-shape` 完成态行文为 `thought ... (Ctrl+T to expand) · <摘要>`，分隔符是 ` · `（空格 + 中点 + 空格）。
- `line-digest` 摘要来自思考原文的末句实质句，跳过「Let me / 现在 / 然后」这类过渡句，超宽按显示列截断并加省略号。
- `line-streaming` 思考进行中显示 `<动画帧> thought <N>s · <当前摘要>`：行首是 braille 点阵动画，计时实时递增，摘要取当时的末句；不带 `(Ctrl+T to expand)` 提示。
- `line-settled` 思考段结束后动画撤下，补上 `(Ctrl+T to expand)` 提示，摘要冻结。
- `line-no-label` 宿主给的隐藏标签为空时（例如被其他扩展清空），插件自行补一个占位符，保证这一行仍然画得出来。
- `line-visible-passthrough` 按 Ctrl+T 展开后，pi 走完整思考的 Markdown 渲染，插件不再改写这一行。

## How to get to it (user POV)

- 保持思考隐藏（默认 `hideThinkingBlock: true`），让模型产生一段思考后再输出正文或工具调用。
- 回放路径：用 `mk-session.py` 生成的会话里每条助手消息都带 `thinking` 块，启动即见。

## Driving it with tmux

Preconditions:

- `./verify.sh launch` 已就绪，屏上能看到回放的两轮问答。
- `/td-status` 报 `已接管` 且 `updateContent 调用` 大于 0。

- **切到 digest 模式。** `tmux send-keys -t "$RUN_ID" "/td-mode digest" Enter`，等 2 秒。
- **抓屏。** `tmux capture-pane -t "$RUN_ID" -p | tee -a "$EVIDENCE_DIR/digest.log"`。
- **断言两行摘要。** 每一轮恰好一行 `thought (Ctrl+T to expand) · 结论是第<一|二>题的答案是<十一|二十二>。`。
- **断言分隔符。** 摘要前必须是 ` · `；出现别的分隔符（`|`、`-`、双空格）即为回归。
- **切到 hide 再切回 digest。** 行文应消失再恢复，见 [hide-mode.md](hide-mode.md) 与 [mode-switch.md](mode-switch.md)。
- **Proof.** `digest.log` 两次 `thought ... · 结论是…` 命中，且 `doctor.log` 同一 RUN_ID。

## Gotchas

- 回放消息没有本进程计时，行文是 `thought (Ctrl+T to expand)`；不要按 `thought <N>s` 断言。
- 摘要取末句，不以句号结尾的思考会让摘要粘住前一句；断言用稳定锚点，不要断言摘要长度。
- 如果模型本次没有产生 `thinking` 块，这一行根本不存在；先查会话文件里有没有 `"type":"thinking"`。
- 按 Ctrl+T 展开后这一行会被完整思考取代，此时找不到 `thought ...` 是正确行为，不是回归。

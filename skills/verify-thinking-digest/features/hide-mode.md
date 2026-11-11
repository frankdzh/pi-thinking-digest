# 全隐藏模式

`/td-mode hide` 时，隐藏思考那一行完全消失：删掉 Text 组件，同时删掉紧贴它前面的空白 Spacer，避免在消息之间留下空行。展开（Ctrl+T）后的完整思考不受影响。

## Sub-features

- `hide-line` 所有 `thought ... (Ctrl+T to expand)` 行消失，屏幕上不留残余字符。
- `hide-spacer` 前面的 Spacer 压成 0 行，消息间距不出现双倍空行；**不删数组元素**，只清空文本。
- `hide-history` 已渲染的历史行同样被收掉，不只是新消息。
- `hide-reversible` 切回 `digest` 后行文完整恢复，顺序与内容不变。
- `hide-streaming` 流式思考期间也不显示 `thinking` 占位行。

## How to get to it (user POV)

- `/td-mode hide`；或按 Ctrl+Shift+K 循环到该模式。

## Driving it with tmux

Preconditions:

- `./verify.sh launch` 已就绪。
- `./verify.sh digest` 通过，屏上有两行摘要。

- **切到 hide。** `tmux send-keys -t "$RUN_ID" "/td-mode hide" Enter`，等 2 秒。
- **抓屏。** `tmux capture-pane -t "$RUN_ID" -p | tee -a "$EVIDENCE_DIR/hide.log"`。
- **断言零行。** `grep -cE "thought .*\\(Ctrl\\+T to expand\\)" hide.log` 必须为 0。
- **断言正文仍在。** 回放的 `11` 与 `22` 仍可见，说明只删了标签行，没有误删助手正文。
- **切回 digest。** `/td-mode digest`，抓 `restore.log`，断言两行回来。
- **Proof.** `hide.log` 零命中 + `restore.log` 两行命中，同一 RUN_ID。

## Gotchas

- 只断言 `thought` 字样可能被启动日志里的扩展名干扰；用 `thought .*\(Ctrl\+T to expand\)` 正则。
- 如果 hide 后正文也消失，说明隐藏逻辑误伤了别的组件，立刻回看 `hide.log` 的前后行。
- 隐藏只清文本、不 splice：宿主和其它扩展按索引缓存 children，删元素会让下一帧渲染拿到 undefined 并崩溃。
- 其他扩展若同时重建这一行（pi-pretty 的 thinkingIndicator、pi-omp-theme 的标签写入），画面上可能闪一下再消失；以最终帧为准。

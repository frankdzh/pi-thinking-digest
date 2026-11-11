# 三模式切换与历史重绘

`/td-mode`（或热键 Ctrl+Shift+K）在 `hide` / `digest` / `latest` 之间切换。切换不仅影响之后的新消息，**必须把屏幕上已有的历史思考行一起重绘**：这是本 feature 的核心，也是曾经被怀疑失效的那条路径。

## Sub-features

- `switch-command` `/td-mode <mode>` 立即生效，并在状态区提示 `thinking-digest 已切换到 <mode>`。
- `switch-hotkey` Ctrl+Shift+K 循环 `hide → digest → latest`（真实终端；tmux 需 extended-keys）。
- `switch-history-repaint` 切换后，已经渲染在屏上的旧消息行按新规则变化，不需要新消息触发。
- `switch-persist` 模式写入 `~/.pi/agent/thinking-digest.json`，下次启动沿用。
- `switch-idempotent` 切到当前模式不报错、不重复堆叠文本。

## How to get to it (user POV)

- 输入 `/td-mode latest`、`/td-mode hide`、`/td-mode digest`。
- 或在真实终端按 Ctrl+Shift+K 循环。

## Driving it with tmux

Preconditions:

- `./verify.sh launch` 已就绪，`./verify.sh digest` 通过（屏上两行摘要）。
- 同一 RUN_ID 的 `artifacts/` 目录已存在。

- **切到 latest。** `tmux send-keys -t "$RUN_ID" "/td-mode latest" Enter`，等 2 秒，抓 `latest.log`。
- **断言旧的收掉、新的留下。** 第一题锚点出现 0 次，第二题锚点出现 1 次。
- **切到 hide。** `/td-mode hide`，抓 `hide.log`，断言 `thought ... (Ctrl+T to expand)` 命中 0 行。
- **切回 digest。** `/td-mode digest`，抓 `restore.log`，断言两行都回来。
- **Proof.** `latest.log` + `hide.log` + `restore.log` 三份同 RUN_ID，全部命中期望行数。

## Gotchas

- 只发一条新消息再断言，证明不了历史重绘；必须用屏幕上**已经存在**的旧行。
- tmux 传统模式把 Ctrl+Shift+K 折成 Ctrl+K，热键项只作参考；模式断言一律走 `/td-mode`。
- 如果 `latest` 通过但 `restore` 失败，说明收行逻辑走了、恢复逻辑没走，重点查 `refreshAllComponents` 与 `liveComponents`。
- 模式文件落在真实 `~/.pi/agent/thinking-digest.json`；隔离环境里改的是临时 agent dir 下的同名文件。

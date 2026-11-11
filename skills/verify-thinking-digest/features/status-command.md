# 诊断与切换命令

`/td-status` 回答“这个插件现在接管到哪一步”，`/td-mode` 回答“当前是哪种模式并切换”。两者都是随时可用的只读/状态命令，不修改消息数据。

## Sub-features

- `status-mode` 报告当前模式（`hide` / `digest` / `latest`）。
- `status-patch` 报告补丁是否绑定到运行时类：`已接管（候选 N 个，已补丁 N 个）`。
- `status-calls` 报告 `updateContent` 实际被调用次数，用于区分“补丁装上了”与“补丁在跑”。
- `status-components` 报告托管组件数、计时条目数、最近一条摘要。
- `mode-usage` `/td-mode` 无参数时打印当前模式与用法；非法模式给出可选值且不改变状态。

## How to get to it (user POV)

- 输入 `/td-status`。
- 输入 `/td-mode` 看用法，`/td-mode <mode>` 切换。

## Driving it with tmux

Preconditions:

- `./verify.sh launch` 已就绪。

- **查状态。** `tmux send-keys -t "$RUN_ID" "/td-status" Enter`，等 2 秒，抓 `doctor.log`。
- **断言接管。** 输出包含 `已接管（候选 <N> 个，已补丁 <N> 个）`。
- **断言真的在跑。** 输出包含 `updateContent 调用 [1-9][0-9]* 次`；数字为 0 说明补丁绑定了但宿主没用这个类。
- **断言模式可读。** 输出包含 `模式 digest`（或当前模式）。
- **空参数用法。** `/td-mode`，断言出现 `用法：/td-mode hide|digest|latest`，且模式不变。
- **非法模式。** `/td-mode bogus`，断言提示 `未知模式`，随后 `/td-status` 仍是原模式。
- **Proof.** `doctor.log` 同时包含接管、调用次数、模式三段。

## Gotchas

- `已接管` 但 `updateContent 调用 0 次` 是真实故障态（补丁绑到了另一份类副本），不要因为看见“已接管”就放过。
- 数字里的实例 ID（`实例 xxxxxx`）每次启动不同，不要拿它做断言。
- 命令输出会被后续渲染推走；每次断言前重新抓屏，别复用上一次的 `doctor.log`。
- 该命令只读，不落盘；模式文件只有在 `/td-mode <mode>` 成功切换后才更新。

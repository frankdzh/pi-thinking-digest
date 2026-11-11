# thinking-digest 验证运行台账

每个 RUN_ID 一行：何时跑的、覆盖了哪些 feature、证据目录、结论。证据与台账同入 Git。
读证据先看本表定位，再进 `artifacts/<RUN_ID>/`。驱动一律走 [`../verify.sh`](../verify.sh)。

| RUN_ID | 日期 | 覆盖 feature | 证据目录 | 结论 |
|---|---|---|---|---|
| td-20261110-110348 | 2026-11-10 | status-command, digest-line, latest-mode, hide-mode, mode-switch（首次自证） | artifacts/td-20261110-110348/ | 全绿：回放两轮思考行与摘要在 digest 下各 1 行；latest 收掉旧行留 1 行；hide 零行；restore 恢复 2 行；doctor 报 `已接管` 且 `updateContent 调用 5 次`。 |
| td-20261110-110541 | 2026-11-10 | 全量回归（清理调试探针后） | artifacts/td-20261110-110541/ | 全绿：launch/doctor/digest/latest/hide/restore 全过，证据 8 文件留存，技能自证完成。 |
| td-20261110-111920 | 2026-11-10 | 全量回归（实时计时 + 行首动画 + 流式摘要） | artifacts/td-20261110-111920/ | 全绿：完成态行文与三模式切换无回归；流式动画段回放不覆盖，见已知限制。 |
| td-20261111-000158 | 2026-11-11 | 全量回归（PV24 tool-tail-fold 批尾错位修复后的避让验收） | artifacts/td-20261111-000158/ | 全绿：digest 两行摘要在位、latest 收旧行、hide 零行、restore 恢复、doctor 报 v2 已接管；双插件同装时批内思考行全部位于 Done 行上方（避让断言在 tool-tail-fold 侧取证）。 |
| td-20261110-113434 | 2026-11-10 | 全量回归（latest 累计时长 + 段数） | artifacts/td-20261110-113434/ | 全绿：回放无计时，latest 行文退化为 `thought (Ctrl+T to expand)`，三模式切换无回归；累计段数由单测覆盖。 |
| td-20261110-115430 | 2026-11-10 | 全量回归（崩溃修复后） | artifacts/td-20261110-115430/ | 全绿：修复 `setWidget` 工厂返回值导致的 `child.render is not a function` 崩溃与 splice 隐患；回放三模式无回归。 |
| tds-20261110-120303 | 2026-11-10 | stream（真实流式：动画帧 + 实时计时 + 崩溃检测） | artifacts/tds-20261110-120303/ | 全绿：帧 A `⠦ thought 0s`、帧 B `⠧ thought 1s`，完成态 `thought 3s (Ctrl+T to expand) · …`，无崩溃堆栈。 |
| td-20261110-124851 | 2026-11-10 | 全量回归（补丁版本标记 v2） | artifacts/td-20261110-124851/ | 全绿：PATCH_MARK 从布尔升级为 {version, original}，/reload 旧闭包可识别并重包；doctor 新增版本号与托管/计时断言。 |

## 已知限制（首次自证时记录）

- 实时模型路径本次未取证：`opencode-zen-free/deepseek-v4.1-flash-free` 与 `magpie/auto/deepseek-v4.1-flash` 在 thinking level `high` 下都没有返回 `"type":"thinking"` 条目，会话文件里 thinking 计数为 0。因此耗时段（`thought <N>s`）只在真实产生思考时才会出现，回放不覆盖。
- 热键项未取证：tmux 未开 `extended-keys`，`C-S-k` 被折叠成 `Ctrl+K`，不触发扩展快捷键。真实终端待人工复核。
- 流式动画与实时计时已由 `./verify.sh stream` 取证（见上表）；它默认不随 `all` 自动跑，改动流式路径时必须手动执行。

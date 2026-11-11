#!/usr/bin/env bash
# thinking-digest 真机验证驱动：tmux 里起 pi、回放确定性会话、断言三模式与摘要、清理并留证。
# 用法见 ./verify.sh help；每个子命令可单独重跑（幂等）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SKILL_DIR="${REPO}/thinking-digest/skills/verify-thinking-digest"
ART_DIR="${SKILL_DIR}/artifacts"
AGENT_DIR="${TD_AGENT_DIR:-/tmp/td-verify-agent}"
RUN_ID="${TD_RUN_ID:-}"
SESS=""
ART=""

die() { echo "verify: $*" >&2; exit 1; }
say() { echo "verify: $*"; }

capture() { tmux capture-pane -t "${SESS}" -p; }
cap_to() { capture | tee "${ART}/$1" >/dev/null; say "证据 → $1"; }
# 流式探针要连历史一起抓：长思考会把行顶出视口
cap_all_to() { tmux capture-pane -t "${SESS}" -p -S -300 | tee "${ART}/$1" >/dev/null; say "证据 → $1"; }

assert_has() {
  local label="$1" pattern="$2" file="$3"
  grep -qE -- "$pattern" "${ART}/$file" \
    || die "断言失败 [$label]：$file 里匹配不到 /$pattern/（先看证据再下结论）"
  say "断言通过 [$label]"
}

assert_count() {
  local label="$1" pattern="$2" expected="$3" file="$4" actual
  actual="$(grep -cE -- "$pattern" "${ART}/$file" || true)"
  [ "$actual" = "$expected" ] \
    || die "断言失败 [$label]：$file 里 /$pattern/ 命中 $actual 行，期望 $expected 行（先看证据）"
  say "断言通过 [$label]：$actual 行"
}

assert_absent() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE -- "$pattern" "${ART}/$file"; then
    die "断言失败 [$label]：$file 里仍有 /$pattern/（先看证据）"
  fi
  say "断言通过 [$label]：无匹配"
}

write_isolated_settings() {
  local dst="$1"
  python3 - "$dst" <<'PY'
import json
import sys

src = os.path.expanduser("~/.pi/agent/settings.json")
try:
    data = json.load(open(src))
except Exception:
    data = {}
data["packages"] = []
data["hideThinkingBlock"] = True
data["defaultProvider"] = "magpie"
data["defaultModel"] = "opencode-zen-free/deepseek-v4.1-flash-free"
data["defaultThinkingLevel"] = "high"
data["quietStartup"] = False
data.pop("theme", None)
json.dump(data, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY
}

prepare_agent() {
  rm -rf "${AGENT_DIR}"
  mkdir -p "${AGENT_DIR}/extensions"
  cp "${HOME}/.pi/agent/keybindings.json" "${AGENT_DIR}/" 2>/dev/null || true
  cp "${HOME}/.pi/agent/auth.json" "${AGENT_DIR}/" 2>/dev/null || true
  cp "${HOME}/.pi/agent/models.json" "${AGENT_DIR}/" 2>/dev/null || true
  write_isolated_settings "${AGENT_DIR}/settings.json"
  ln -sfn "${REPO}/thinking-digest/index.ts" "${AGENT_DIR}/extensions/thinking-digest.ts"
}

launch() {
  [ -n "${RUN_ID}" ] || RUN_ID="td-$(date +%Y%m%d-%H%M%S)"
  SESS="${RUN_ID}"
  ART="${ART_DIR}/${RUN_ID}"
  mkdir -p "${ART}"
  if tmux has-session -t "${SESS}" 2>/dev/null; then
    die "会话 ${SESS} 已存在；换 TD_RUN_ID 或先 tmux kill-session -t ${SESS}"
  fi

  prepare_agent

  python3 "${SKILL_DIR}/mk-session.py" --out "${ART}/session.jsonl" | tee "${ART}/session-notes.txt" >/dev/null
  say "确定性会话已生成：${ART}/session.jsonl（不调模型）"

  tmux new-session -d -s "${SESS}" -x 140 -y 42
  tmux send-keys -t "${SESS}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --session ${ART}/session.jsonl --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 10
  cap_to launch.log
  grep -q "thinking-digest.ts" "${ART}/launch.log" || die "launch 未就绪：扩展未加载，见 launch.log"
  grep -q "Lock file is already being held" "${ART}/launch.log" && die "launch 失败：settings 锁冲突"
  echo "${RUN_ID}" > "${ART_DIR}/.current-run"
  say "就绪 RUN_ID=${RUN_ID}（${ART_DIR}/.current-run）"
}

need_run() {
  [ -n "${RUN_ID}" ] || RUN_ID="$(cat "${ART_DIR}/.current-run" 2>/dev/null)" || die "没有活动 run；先跑 ./verify.sh launch"
  SESS="${RUN_ID}"
  ART="${ART_DIR}/${RUN_ID}"
  mkdir -p "${ART}"
}

doctor() {
  need_run
  tmux send-keys -t "${SESS}" "/td-status" Enter
  sleep 2
  cap_to doctor.log
  assert_has "补丁接管（含版本号）" "已接管（候选 [0-9]+ 个，已补丁 [0-9]+ 个（v[0-9]+））" doctor.log
  assert_has "托管与计时在岗" "托管组件 [0-9]+ 个，计时 [0-9]+ 条" doctor.log
  assert_has "updateContent 被调用" "updateContent 调用 [1-9][0-9]* 次" doctor.log
}

digest() {
  need_run
  tmux send-keys -t "${SESS}" "/td-mode digest" Enter
  sleep 2
  cap_to digest.log
  assert_count "第一条摘要行" "Thought .*\\(Ctrl\\+T to expand\\) · 结论是第一题的答案是十一。" 1 digest.log
  assert_count "第二条摘要行" "Thought .*\\(Ctrl\\+T to expand\\) · 结论是第二题的答案是二十二。" 1 digest.log
}

# latest 的折叠范围必须是「一轮」（一条助手消息），不是整场会话：
# 每轮各留一行，旧轮的行不能被整轮删掉。
latest() {
  need_run
  tmux send-keys -t "${SESS}" "/td-mode latest" Enter
  sleep 2
  cap_to latest.log
  assert_count "每轮各留一行（共 2 轮）" "Thought .*\\(Ctrl\\+T to expand\\)" 2 latest.log
  assert_has "第一轮的行还在" "· 结论是第一题的答案是十一。" latest.log
  assert_has "第二轮的行还在" "· 结论是第二题的答案是二十二。" latest.log
}

hide() {
  need_run
  tmux send-keys -t "${SESS}" "/td-mode hide" Enter
  sleep 2
  cap_to hide.log
  assert_absent "全隐藏" "Thought .*\\(Ctrl\\+T to expand\\)" hide.log
}

restore() {
  need_run
  tmux send-keys -t "${SESS}" "/td-mode digest" Enter
  sleep 2
  cap_to restore.log
  assert_count "恢复两行" "Thought .*\\(Ctrl\\+T to expand\\)" 2 restore.log
}

# 无思考消息的正文安全：pi-omp-theme 把 hiddenThinkingLabel 清空后，
# 扩展需要补占位标签；占位符若能被正文子串命中，整段正文会被当标签行清掉。
# 无模型、无 tmux，直接跑 node 探针（正文含省略号 + label 为空）。
prose() {
  [ -e "${REPO}/thinking-digest/node_modules" ] || ln -sfn "${HOME}/.pi/agent/install/releases/$(cat "${HOME}/.pi/agent/install/current-version")/node_modules" "${REPO}/thinking-digest/node_modules"
  cp "${SKILL_DIR}/prose-safety.mjs" "${REPO}/thinking-digest/.prose-safety.mjs"
  ( cd "${REPO}/thinking-digest" && node .prose-safety.mjs ) || die "正文安全探针失败：无思考消息的正文被扩展清空"
  rm -f "${REPO}/thinking-digest/.prose-safety.mjs"
  say "prose 通过：无思考消息的正文完整保留"
}

# latest 的折叠范围：一行只能代表一轮，不能报整场会话的累计段数。
# 回放没有计时，段数标签只在流式出现，故用模块级计时直接验（无模型/无 tmux）。
scope() {
  [ -e "${REPO}/thinking-digest/node_modules" ] || ln -sfn "${HOME}/.pi/agent/install/releases/$(cat "${HOME}/.pi/agent/install/current-version")/node_modules" "${REPO}/thinking-digest/node_modules"
  cp "${SKILL_DIR}/latest-scope.mjs" "${REPO}/thinking-digest/.scope.mjs"
  ( cd "${REPO}/thinking-digest" && node .scope.mjs ) || die "折叠范围探针失败：latest 把整场会话的段数累计进一行"
  rm -f "${REPO}/thinking-digest/.scope.mjs"
  say "scope 通过：latest 的段数按轮统计"
}

# 回合折叠的资格转移：模块级探针，验证带行资格从旧消息转到新消息时，
# 旧消息的行会被自动重绘掉，且下一个用户回合不清旧回合的行（无模型/无 tmux）。
turnscope() {
  [ -e "${REPO}/thinking-digest/node_modules" ] || ln -sfn "${HOME}/.pi/agent/install/releases/$(cat "${HOME}/.pi/agent/install/current-version")/node_modules" "${REPO}/thinking-digest/node_modules"
  cp "${SKILL_DIR}/turn-scope.mjs" "${REPO}/thinking-digest/.turnscope.mjs"
  ( cd "${REPO}/thinking-digest" && node .turnscope.mjs ) || die "回合折叠探针失败：latest 的带行资格没按用户回合转移"
  rm -f "${REPO}/thinking-digest/.turnscope.mjs"
  say "turnscope 通过：latest 按用户回合折叠且带行资格正确转移"
}

# 进程内换会话（/resume、会话选择器、fork）：pi 先渲染历史再绑定扩展。
# 绑定前那一渲染拿不到会话条目，历史行会定稿成无时长；绑定后必须重绘。
# 模块级探针，复刻这个顺序（无模型/无 tmux）。
rebind() {
  [ -e "${REPO}/thinking-digest/node_modules" ] || ln -sfn "${HOME}/.pi/agent/install/releases/$(cat "${HOME}/.pi/agent/install/current-version")/node_modules" "${REPO}/thinking-digest/node_modules"
  cp "${SKILL_DIR}/rebind-scope.mjs" "${REPO}/thinking-digest/.rebind.mjs"
  ( cd "${REPO}/thinking-digest" && node .rebind.mjs ) || die "进程内换会话探针失败：绑定后旧行没有重绘成带时长"
  rm -f "${REPO}/thinking-digest/.rebind.mjs"
  say "rebind 通过：进程内换会话后历史行被重绘，时长恢复"
}

shortcut() {
  need_run
  # tmux 传统模式不带 extended-keys，Ctrl+Shift+K 常被折叠成 Ctrl+K，
  # 因此这一项只作参考：透传成功时底部会出现模式提示。
  tmux send-keys -t "${SESS}" C-S-k
  sleep 2
  cap_to shortcut.log
  if grep -qE "thinking-digest 已切换到" "${ART}/shortcut.log"; then
    say "快捷键透传成功（见 shortcut.log）"
  else
    say "快捷键未透传：tmux extended-keys 关闭时不判失败，真实终端人工复核"
  fi
}

# 非思考正文显示：单条消息内 text/thinking 交错（大师 2026-11-11 报障场景）。
# 自起独立 tmux 会话回放交错会话（pi 无运行时 /session 切换命令）。
# 断言：三段正文 A/B/C 全部可见；思考行存在。
interleave() {
  [ -d "${AGENT_DIR}/extensions" ] || prepare_agent
  local RUN_ID2="tdi-$(date +%Y%m%d-%H%M%S)"
  local SESS2="${RUN_ID2}"
  local ART2="${ART_DIR}/${RUN_ID2}"
  mkdir -p "${ART2}"
  ART="${ART2}"
  python3 "${SKILL_DIR}/mk-session.py" --interleaved --out "${ART2}/interleave.jsonl" >/dev/null
  tmux new-session -d -s "${SESS2}" -x 140 -y 42
  tmux send-keys -t "${SESS2}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --session ${ART2}/interleave.jsonl --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 14
  tmux capture-pane -t "${SESS2}" -p -S -100 > "${ART2}/interleave.log"
  say "证据 → ${RUN_ID2}/interleave.log"
  assert_has "思考前正文 A 可见" "这是思考之前的正文 A。" "interleave.log"
  assert_has "思考间正文 B 可见" "这是两个思考块之间的正文 B。" "interleave.log"
  assert_has "思考后正文 C 可见" "这是思考之后的正文 C。" "interleave.log"
  # 思考行：hiddenThinkingBlock=true 时是标签行；被接管后是摘要行。两者都算显示。
  if grep -qE "Thinking\.\.\.|Thought|· 第一段思考|· 第二段思考|第一段思考：先分析问题" "${ART2}/interleave.log"; then
    say "断言通过 [思考行存在（标签或摘要）]"
  else
    die "断言失败 [思考行存在]：interleave.log 里无任何思考行"
  fi
  tmux kill-session -t "${SESS2}" 2>/dev/null || true
  say "interleave 通过：非思考正文三段全部可见"
}

# 多思考段分轮：折叠范围必须是一轮（一条助手消息），不是整场会话。
# digest 下每段各一行、各报自己的摘要；latest 下每轮只折叠成一行，段数按轮统计。
# 自起独立 tmux 会话回放（需要独立的进程级状态）。
fold() {
  [ -d "${AGENT_DIR}/extensions" ] || prepare_agent
  local RUN_ID2="tdf-$(date +%Y%m%d-%H%M%S)"
  local SESS2="${RUN_ID2}"
  local ART2="${ART_DIR}/${RUN_ID2}"
  mkdir -p "${ART2}"
  ART="${ART2}"
  python3 "${SKILL_DIR}/mk-session.py" --rounds --out "${ART2}/rounds.jsonl" >/dev/null
  tmux new-session -d -s "${SESS2}" -x 160 -y 50
  tmux send-keys -t "${SESS2}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --session ${ART2}/rounds.jsonl --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 14
  tmux send-keys -t "${SESS2}" "/td-mode digest" Enter
  sleep 2
  tmux capture-pane -t "${SESS2}" -p -S -200 > "${ART2}/digestfold.log"
  say "证据 → ${RUN_ID2}/digestfold.log"
  # digest：6 段思考各一行，各报自己的摘要（不能六行同一句）。
  assert_count "六段思考各占一行" "· 第[0-9]轮第[0-9]段思考" 6 digestfold.log
  assert_count "第一段的摘要独立" "· 第1轮第1段思考" 1 digestfold.log

  tmux send-keys -t "${SESS2}" "/td-mode latest" Enter
  sleep 2
  tmux capture-pane -t "${SESS2}" -p -S -200 > "${ART2}/latestfold.log"
  say "证据 → ${RUN_ID2}/latestfold.log"
  # 三轮各一行：整场会话不该只剩一行，也不该一轮冒出多行。
  assert_count "每轮一行（共 3 行）" "Thought .*\\(Ctrl\\+T to expand\\)" 3 latestfold.log
  assert_count "第 3 轮只折叠成一行" "· 第3轮第3段思考" 1 latestfold.log
  assert_count "第 2 轮只折叠成一行" "· 第2轮第2段思考" 1 latestfold.log
  assert_count "第 1 轮只折叠成一行" "· 第1轮第1段思考" 1 latestfold.log
  # 段数口径按轮：第 3 轮有 3 段，第 2 轮 2 段，第 1 轮 1 段（不报段数）。
  assert_has "第 3 轮报 3 段" "\\(3 runs\\)" latestfold.log
  assert_has "第 2 轮报 2 段" "\\(2 runs\\)" latestfold.log
  tmux kill-session -t "${SESS2}" 2>/dev/null || true
  say "fold 通过：折叠范围是一轮，digest 每段一行、latest 每轮一行且段数按轮"
}

# 工具循环：一个用户回合里有多次「思考 + 工具调用」，也就是真实会话的形态。
# latest 的折叠范围必须是一整个用户回合：每轮只留一行，不是每条助手消息一行。
agentic() {
  [ -d "${AGENT_DIR}/extensions" ] || prepare_agent
  local RUN_ID2="tda-$(date +%Y%m%d-%H%M%S)"
  local SESS2="${RUN_ID2}"
  local ART2="${ART_DIR}/${RUN_ID2}"
  mkdir -p "${ART2}"
  ART="${ART2}"
  python3 "${SKILL_DIR}/mk-session.py" --agentic --out "${ART2}/agentic.jsonl" >/dev/null
  tmux new-session -d -s "${SESS2}" -x 160 -y 80
  tmux send-keys -t "${SESS2}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --session ${ART2}/agentic.jsonl --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 14
  tmux send-keys -t "${SESS2}" "/td-mode latest" Enter
  sleep 2
  tmux capture-pane -t "${SESS2}" -p -S -200 > "${ART2}/agentic.log"
  say "证据 → ${RUN_ID2}/agentic.log"
  # 两轮 → 两行。修前是每条助手消息一行（第 1 轮 3 行 + 第 2 轮 2 行）。
  assert_count "每轮折叠成一行（共 2 行）" "Thought .*\\(Ctrl\\+T to expand\\)" 2 agentic.log
  assert_has "第 1 轮报本轮 3 段" "\\(3 runs\\)" agentic.log
  assert_has "第 2 轮报本轮 2 段" "\\(2 runs\\)" agentic.log
  assert_count "第 1 轮只剩最后一次思考" "· 第1轮第3次思考" 1 agentic.log
  assert_absent "第 1 轮的中间迭代不再各占一行" "· 第1轮第1次思考" agentic.log
  assert_absent "第 1 轮的中间迭代不再各占一行" "· 第1轮第2次思考" agentic.log
  tmux kill-session -t "${SESS2}" 2>/dev/null || true
  say "agentic 通过：latest 按用户回合折叠"
}

# 重启后时长不能丢：会话里已有本扩展落盘的思考墙钟（thinking-digest-timing），
# 回放等价于「退出再进来」——latest 行必须仍是 `Thought for Ns`，不能退化成 `Thought (N runs)`。
# 第 1 轮 3 条合计 1s，第 2 轮 2 条合计 2s。
timed() {
  [ -d "${AGENT_DIR}/extensions" ] || prepare_agent
  local RUN_ID2="tdt-$(date +%Y%m%d-%H%M%S)"
  local SESS2="${RUN_ID2}"
  local ART2="${ART_DIR}/${RUN_ID2}"
  mkdir -p "${ART2}"
  ART="${ART2}"
  python3 "${SKILL_DIR}/mk-session.py" --agentic --out "${ART2}/timed.jsonl" >/dev/null
  tmux new-session -d -s "${SESS2}" -x 160 -y 80
  tmux send-keys -t "${SESS2}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --session ${ART2}/timed.jsonl --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 14
  tmux send-keys -t "${SESS2}" "/td-mode latest" Enter
  sleep 2
  tmux capture-pane -t "${SESS2}" -p -S -200 > "${ART2}/timed.log"
  say "证据 → ${RUN_ID2}/timed.log"
  assert_has "第 1 轮保留 1s" "Thought for 1s.*\\(3 runs\\)" timed.log
  assert_has "第 2 轮保留 2s" "Thought for 2s.*\\(2 runs\\)" timed.log
  assert_absent "不再退化成只有段数" "Thought \\([0-9]+ runs\\) \\(Ctrl\\+T" timed.log
  tmux kill-session -t "${SESS2}" 2>/dev/null || true
  say "timed 通过：重启后时长与 for 仍在"
}

# 重启保时（真机端到端）：真模型跑一轮带思考的对话 → 记录行上的时长 →
# 杀掉进程用同一会话重新进来 → 行上时长必须与退出前一致。
# 只验真实链路，不调模型不可替代，故不放进 all（与 stream 同级）。
restart() {
  [ -d "${AGENT_DIR}/extensions" ] || prepare_agent
  local RUN_ID2="tdr-$(date +%Y%m%d-%H%M%S)"
  local SESS2="${RUN_ID2}"
  local ART2="${ART_DIR}/${RUN_ID2}"
  mkdir -p "${ART2}"
  ART="${ART2}"
  local model="${TD_STREAM_MODEL:-auto/deepseek-v4.1-flash}"
  tmux new-session -d -s "${SESS2}" -x 160 -y 60
  tmux send-keys -t "${SESS2}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --model ${model} --thinking high --tui-mode regular --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 12
  # 免费模型不一定每次都吐思考块：同会话里最多试两次
  local attempt=1 i
  while : ; do
    if [ "${attempt}" = "1" ]; then
      tmux send-keys -t "${SESS2}" "认真思考 10 秒再回答：17 的平方是多少？只用一句话给出结论。" Enter
    else
      tmux send-keys -t "${SESS2}" "再想一遍：17 乘 17 等于多少？先推理再给结论。" Enter
    fi
    i=0
    while [ "${i}" -lt 70 ]; do
      tmux capture-pane -t "${SESS2}" -p -S -200 > "${ART2}/restart-live.log"
      grep -qE "Thought for [0-9]+s" "${ART2}/restart-live.log" && break
      sleep 2
      i=$((i + 2))
    done
    grep -qE "Thought for [0-9]+s" "${ART2}/restart-live.log" && break
    [ "${attempt}" -ge 2 ] && die "live 阶段两轮都没抓到带时长的行（模型未思考），换 TD_STREAM_MODEL 再试，见 restart-live.log"
    attempt=$((attempt + 1))
  done
  local before
  before="$(grep -oE "Thought for [0-9]+s" "${ART2}/restart-live.log" | head -1)"
  local session_file
  session_file="$(ls -t "${AGENT_DIR}"/sessions/*/*.jsonl 2>/dev/null | head -1)"
  [ -n "${session_file}" ] || die "找不到会话文件，无法重进"
  grep -q "thinking-digest-timing" "${session_file}" \
    || die "会话文件里没有写入思考墙钟条目（thinking-digest-timing）"
  tmux kill-session -t "${SESS2}" 2>/dev/null || true
  sleep 2
  tmux new-session -d -s "${SESS2}" -x 160 -y 60
  tmux send-keys -t "${SESS2}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --session ${session_file} --tui-mode regular --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 13
  tmux capture-pane -t "${SESS2}" -p -S -200 > "${ART2}/restart-replay.log"
  say "退出前 ${before}；重进后见 restart-replay.log"
  assert_has "重进后时长与 for 仍在" "${before}" restart-replay.log
  tmux kill-session -t "${SESS2}" 2>/dev/null || true
  say "restart 通过：退出再进来那行仍是同样的 Thought for Ns"
}

# 进程内换会话（真机）：同一进程里 /resume 切进已落盘时长的会话。
# pi 的顺序是先渲染历史再绑定扩展，所以这一项专门验「绑定后重绘」。
# 选择器交互依赖 UI（列表顺序：当前会话在前，夹具在后），失败时看证据再判断。
resume() {
  [ -d "${AGENT_DIR}/extensions" ] || prepare_agent
  local RUN_ID2="tdq-$(date +%Y%m%d-%H%M%S)"
  local SESS2="${RUN_ID2}"
  local ART2="${ART_DIR}/${RUN_ID2}"
  mkdir -p "${ART2}"
  ART="${ART2}"
  python3 "${SKILL_DIR}/mk-session.py" --agentic --out "${ART2}/timed.jsonl" >/dev/null
  local sessions_dir
  sessions_dir="$(ls -d "${AGENT_DIR}"/sessions/*/ 2>/dev/null | head -1)"
  if [ -z "${sessions_dir}" ]; then
    local cwd_slug
    cwd_slug="$(pwd | sed 's|^/|-|; s|/|-|g')"
    sessions_dir="${AGENT_DIR}/sessions/${cwd_slug}/"
    mkdir -p "${sessions_dir}"
  fi
  cp "${ART2}/timed.jsonl" "${sessions_dir}2026-11-11T14-30-00-000Z_resume-probe.jsonl"
  tmux new-session -d -s "${SESS2}" -x 160 -y 60
  tmux send-keys -t "${SESS2}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --tui-mode regular --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 12
  tmux send-keys -t "${SESS2}" "/resume" Enter
  sleep 4
  tmux capture-pane -t "${SESS2}" -p > "${ART2}/selector-open.log"
  # 用选择器的过滤输入定位夹具（列表顺序随会话数量变化，不能靠方向键）
  tmux send-keys -t "${SESS2}" "第1轮提问"
  sleep 2
  tmux capture-pane -t "${SESS2}" -p > "${ART2}/selector.log"
  grep -q "› 第1轮提问：把这件事做完。" "${ART2}/selector.log" \
    || die "选择器里没定位到夹具会话，见 selector.log"
  tmux send-keys -t "${SESS2}" Enter
  sleep 5
  tmux send-keys -t "${SESS2}" "/td-mode latest" Enter
  sleep 2
  tmux capture-pane -t "${SESS2}" -p -S -200 > "${ART2}/resume.log"
  say "证据 → ${RUN_ID2}/resume.log"
  assert_has "进程内切换后第 1 轮保留 1s" "Thought for 1s.*\\(3 runs\\)" resume.log
  assert_has "进程内切换后第 2 轮保留 2s" "Thought for 2s.*\\(2 runs\\)" resume.log
  tmux kill-session -t "${SESS2}" 2>/dev/null || true
  say "resume 通过：进程内换会话后时长仍在"
}

all() {
  prose
  scope
  turnscope
  rebind
  doctor
  digest
  latest
  fold
  agentic
  timed
  hide
  restore
  if [ "${TD_LIVE:-0}" = "1" ]; then
    cleanup
    stream
  fi
}

wait_frame() {
  local file="$1" limit="${2:-40}" i=0
  while [ "${i}" -lt "${limit}" ]; do
    tmux capture-pane -t "${SESS}" -p -S -400 > "${ART}/${file}"
    if grep -qE "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking [0-9]+s" "${ART}/${file}"; then
      say "证据 → ${file}（第 ${i}s 抓到流式帧）"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

crash_guard() {
  local file
  for file in "$@"; do
    if grep -qE "child\.render is not a function|TypeError|RangeError|Maximum call stack|Cannot read propert" "${file}"; then
      die "检测到崩溃：$(basename "${file}") 出现运行时异常堆栈（见该文件）"
    fi
  done
  say "断言通过 [进程存活]：无运行时异常堆栈"
}

stream() {
  [ -n "${RUN_ID}" ] || RUN_ID="tds-$(date +%Y%m%d-%H%M%S)"
  SESS="${RUN_ID}"
  ART="${ART_DIR}/${RUN_ID}"
  mkdir -p "${ART}"
  if tmux has-session -t "${SESS}" 2>/dev/null; then
    die "会话 ${SESS} 已存在；换 TD_RUN_ID 或先 tmux kill-session -t ${SESS}"
  fi

  prepare_agent
  local model="${TD_STREAM_MODEL:-auto/deepseek-v4.1-flash}"
  tmux new-session -d -s "${SESS}" -x 140 -y 42
  tmux send-keys -t "${SESS}" \
    "cd ${REPO} && PI_CODING_AGENT_DIR=${AGENT_DIR} pi --model ${model} --thinking high --tui-mode regular --no-context-files --no-skills --no-prompt-templates --no-mcp" Enter
  sleep 9
  cap_all_to stream-launch.log
  grep -q "thinking-digest.ts" "${ART}/stream-launch.log" || die "stream 启动失败：扩展未加载"
  echo "${RUN_ID}" > "${ART_DIR}/.current-run"

  # 长推理提示词：实测 auto/deepseek-v4.1-flash --thinking high 会思考约 9s
  tmux send-keys -t "${SESS}" "请在思考里详细推导皮亚诺公理如何推出 1+1=2（至少写 200 字推理），推导完只回答一个字：是。" Enter
  wait_frame stream-frame-a.log 40 || die "40s 内没抓到流式帧（模型未思考或渲染未生效），见 ${ART}/stream-frame-a.log"
  sleep 1
  cap_all_to stream-frame-b.log
  crash_guard "${ART}/stream-launch.log" "${ART}/stream-frame-a.log" "${ART}/stream-frame-b.log"
  assert_has "流式帧 A 有动画与实时计时" "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking [0-9]+s" stream-frame-a.log
  if grep -qE "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking [0-9]+s" "${ART}/stream-frame-b.log"; then
    assert_has "流式帧 B 有动画与实时计时" "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking [0-9]+s" stream-frame-b.log
  else
    say "帧 B 未捕获（思考在 1s 内结束）；以帧 A 证明流式渲染，不判失败"
  fi

  sleep "${TD_STREAM_WAIT:-30}"
  cap_all_to stream-done.log
  crash_guard "${ART}/stream-done.log"
  assert_has "完成态行文" "Thought for [0-9]+s.*\(.* to expand\) · .+" stream-done.log
  say "stream 通过：流式两帧仍在跑、完成后行文完整、进程未崩溃"
}

cleanup() {
  need_run
  tmux kill-session -t "${SESS}" 2>/dev/null || true
  say "已关闭 tmux 会话 ${SESS}"
  if [ "${TD_KEEP_AGENT:-0}" != "1" ]; then
    rm -rf "${AGENT_DIR}"
    say "已删除隔离 agent dir ${AGENT_DIR}"
  else
    say "保留隔离 agent dir ${AGENT_DIR}（TD_KEEP_AGENT=1）"
  fi
  [ -d "${ART}" ] || die "cleanup 吃掉了证据目录 ${ART}"
  say "证据留存：${ART}（$(ls "${ART}" | wc -l | tr -d ' ') 个文件）"
  rm -f "${ART_DIR}/.current-run"
}

help() {
  cat <<'TXT'
用法: ./verify.sh <命令>

launch    建隔离 agent dir（PI_CODING_AGENT_DIR）+ 确定性回放会话，tmux 起 pi
doctor    /td-status，断言补丁接管且 updateContent 被调用
digest    /td-mode digest，断言两条 Thought 摘要行
latest    /td-mode latest，断言每轮各留一行（不是整场只剩一行）
hide      /td-mode hide，断言整行消失
restore   /td-mode digest，断言两行回来
shortcut  尝试 tmux 发送 Ctrl+Shift+K（extended-keys 关闭时仅参考）
interleave 单条消息内 text/thinking 交错回放，断言三段非思考正文全部可见
prose     无思考消息 + 正文含省略号 + label 为空，断言正文不被清空（无模型/无 tmux）
agentic    一个用户回合内多次「思考+工具调用」的回放，断言 latest 按用户回合折叠成一行
timed      已落盘时长的会话回放，断言重启后 latest 行仍是 Thought for Ns
rebind     进程内换会话的模块级探针，断言绑定后历史行重绘并恢复时长（无模型/无 tmux）
resume     真机 /resume 进程内切换，断言切进后时长仍在（依赖会话选择器 UI）
restart    真模型一轮 + 杀掉重进，断言行上时长与退出前一致（会调模型，不进 all）
fold      三轮各 1/2/3 段思考的回放：digest 每段一行各报摘要，latest 每轮折叠成一行、段数按轮
scope     latest 段数按轮统计的模块级探针（无模型/无 tmux）
turnscope latest 带行资格按用户回合转移的模块级探针（无模型/无 tmux）
stream    真实流式探针：普通模型 + 长推理，抓两帧断言动画/计时，并检测崩溃
all       prose → scope → turnscope → doctor → digest → latest → fold → hide → restore（TD_LIVE=1 时末尾追加 stream）
cleanup   关闭 tmux 会话、删隔离 agent dir、保留 artifacts

环境变量: TD_AGENT_DIR 隔离目录 / TD_RUN_ID 复用运行 / TD_KEEP_AGENT=1 保留目录
          TD_STREAM_MODEL 流式探针模型（默认 auto/deepseek-v4.1-flash）
          TD_STREAM_WAIT 完成后等待秒数（默认 30）/ TD_LIVE=1 让 all 末尾跑 stream
TXT
}

case "${1:-help}" in
  launch) launch ;;
  doctor) doctor ;;
  digest) digest ;;
  latest) latest ;;
  hide) hide ;;
  restore) restore ;;
  shortcut) shortcut ;;
  stream) stream ;;
  all) all ;;
  interleave) interleave ;;
  prose) prose ;;
  scope) scope ;;
  turnscope) turnscope ;;
  fold) fold ;;
  agentic) agentic ;;
  timed) timed ;;
  rebind) rebind ;;
  resume) resume ;;
  restart) restart ;;
  cleanup) cleanup ;;
  help|-h|--help) help ;;
  *) die "未知命令: $1（./verify.sh help）" ;;
esac

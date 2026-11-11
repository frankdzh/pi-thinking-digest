#!/usr/bin/env python3
"""生成确定性回放会话：两条带思考的助手消息，用于验收 thinking-digest。

不调模型：会话文件里直接写 thinking 块，pi 只做渲染。这样验收不依赖
"模型这次愿不愿意思考"，摘要与隐藏行都能稳定断言。

用法：
    python3 mk-session.py --out /tmp/td-probe.jsonl [--turns 2]

输出的 JSONL 里每条助手消息的 thinking 末句都是唯一的断言锚点：
    turn 1 -> 结论是第一题的答案是十一。
    turn 2 -> 结论是第二题的答案是二十二。
"""
import argparse
import datetime
import json
import os
import uuid

CWD = os.environ.get("TD_VERIFY_CWD", os.path.join(os.path.expanduser("~"), "code", "my_plugins"))

TURNS = [
    {
        "user": "第一题：11 加 0 等于多少？",
        "thinking": "先看第一题，这是加法。结论是第一题的答案是十一。",
        "answer": "11",
        "anchor": "结论是第一题的答案是十一。",
    },
    {
        "user": "第二题：22 加 0 等于多少？",
        "thinking": "再算第二题，同样是加法。结论是第二题的答案是二十二。",
        "answer": "22",
        "anchor": "结论是第二题的答案是二十二。",
    },
]


def iso(ms: int) -> str:
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%f"
    )[:-3] + "Z"


def entry(entry_id: str, parent: str | None, ms: int, message: dict) -> dict:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": parent,
        "timestamp": iso(ms),
        "message": message,
    }


def build(turn_count: int) -> list[dict]:
    base = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    lines: list[dict] = [
        {
            "type": "session",
            "version": 3,
            "id": str(uuid.uuid4()),
            "timestamp": iso(base),
            "cwd": CWD,
        }
    ]
    parent = None
    for index, turn in enumerate(TURNS[:turn_count]):
        user_ms = base + index * 10_000
        assistant_ms = user_ms + 5_000
        user_id = uuid.uuid4().hex[:8]
        lines.append(
            entry(
                user_id,
                parent,
                user_ms,
                {
                    "role": "user",
                    "content": [{"type": "text", "text": turn["user"]}],
                    "timestamp": user_ms,
                },
            )
        )
        assistant_id = uuid.uuid4().hex[:8]
        lines.append(
            entry(
                assistant_id,
                user_id,
                assistant_ms,
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": turn["thinking"]},
                        {"type": "text", "text": turn["answer"]},
                    ],
                    "api": "openai-completions",
                    "provider": "magpie",
                    "model": "opencode-zen-free/deepseek-v4.1-flash-free",
                    "usage": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "reasoning": 0,
                        "totalTokens": 0,
                        "cost": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "total": 0,
                            "totalFromProvider": False,
                        },
                    },
                    "stopReason": "stop",
                    "timestamp": assistant_ms,
                    "responseId": f"probe-{index}",
                    "rawStopReason": "stop",
                    "durationMs": 1200,
                    "thinkingLevel": "high",
                },
            )
        )
        parent = assistant_id
    return lines


# 工具循环夹具：一个用户回合里有多条助手消息（每次工具调用一轮），
# 这才是真实会话的形态——思考行的折叠范围必须是一整个用户回合，
# 不是单条助手消息。
AGENTIC_TURNS = [
    # (轮次, 该轮内带思考的助手次数)：规模控制在 50 行视口内，便于整屏断言
    (1, 3),
    (2, 2),
]


def agentic_anchor(round_no: int, iteration: int) -> str:
    return f"第{round_no}轮第{iteration}次思考：这里推敲第{round_no}轮的第{iteration}步。"


# 每条助手消息记录的思考墙钟（毫秒）：模拟「本扩展已把时长写进会话」的状态。
# 第 1 轮 3 条合计 1000ms → Thought for 1s；第 2 轮 2 条合计 2000ms → Thought for 2s。
AGENTIC_MS = {(1, 1): 400, (1, 2): 300, (1, 3): 300, (2, 1): 900, (2, 2): 1100}


def timing_entry(parent: str | None, message_ts: int, ms: int, clock: int) -> dict:
    """本扩展写入会话的思考墙钟条目（type=custom，不进上下文）。

    `data.ts` 是被计时的那条助手消息的时间戳，`data.ms` 是实测墙钟。
    """
    return {
        "type": "custom",
        "customType": "thinking-digest-timing",
        "data": {"ts": message_ts, "ms": ms},
        "id": uuid.uuid4().hex[:8],
        "parentId": parent,
        "timestamp": iso(clock),
    }


def build_agentic(base: int) -> list[dict]:
    """两轮用户提问，每轮内部是多次「思考 + 工具调用」的助手消息。

    第 1 轮 3 条带思考的助手消息，第 2 轮 2 条；每条都挂一个 toolCall，
    中间插入 toolResult，最后一条带正文答案。每条助手消息前插一条
    thinking-digest-timing 条目，模拟「时长已落盘」的重启现场。

    顺序对齐真实树形：pi 先触发 message_end（扩展在这里 appendEntry），
    再把助手消息写进会话，所以计时条目是助手消息的父节点。
    """
    lines: list[dict] = [
        {
            "type": "session",
            "version": 3,
            "id": str(uuid.uuid4()),
            "timestamp": iso(base),
            "cwd": CWD,
        }
    ]
    parent = None
    clock = base
    for round_no, iterations in AGENTIC_TURNS:
        clock += 10_000
        user_id = uuid.uuid4().hex[:8]
        lines.append(
            entry(
                user_id,
                parent,
                clock,
                {
                    "role": "user",
                    "content": [{"type": "text", "text": f"第{round_no}轮提问：把这件事做完。"}],
                    "timestamp": clock,
                },
            )
        )
        parent = user_id
        for iteration in range(1, iterations + 1):
            clock += 2_000
            assistant_id = uuid.uuid4().hex[:8]
            call_id = f"call_{round_no}_{iteration}"
            content: list[dict] = [
                {"type": "thinking", "thinking": agentic_anchor(round_no, iteration)},
                {"type": "toolCall", "id": call_id, "name": "bash", "arguments": {"command": "true"}},
            ]
            if iteration == iterations:
                content.append({"type": "text", "text": f"第{round_no}轮答案。"})
            timing = timing_entry(parent, clock, AGENTIC_MS[(round_no, iteration)], clock + 100)
            lines.append(timing)
            lines.append(
                entry(
                    assistant_id,
                    timing["id"],
                    clock,
                    {
                        "role": "assistant",
                        "content": content,
                        "api": "openai-completions",
                        "provider": "magpie",
                        "model": "opencode-zen-free/deepseek-v4.1-flash-free",
                        "usage": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "reasoning": 0,
                            "totalTokens": 0,
                            "cost": {
                                "input": 0,
                                "output": 0,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                                "total": 0,
                                "totalFromProvider": False,
                            },
                        },
                        "stopReason": "stop",
                        "timestamp": clock,
                        "responseId": f"probe-agentic-{round_no}-{iteration}",
                        "rawStopReason": "stop",
                        "durationMs": 900,
                        "thinkingLevel": "high",
                    },
                )
            )
            parent = assistant_id
            clock += 400
            result_id = uuid.uuid4().hex[:8]
            lines.append(
                entry(
                    result_id,
                    parent,
                    clock,
                    {
                        "role": "toolResult",
                        "toolCallId": call_id,
                        "toolName": "bash",
                        "content": [{"type": "text", "text": f"(第{round_no}轮第{iteration}步输出)"}],
                        "timestamp": clock,
                    },
                )
            )
            parent = result_id
    return lines


INTERLEAVED = [
    "这是思考之前的正文 A。",
    "第一段思考：先分析问题。",
    "这是两个思考块之间的正文 B。",
    "第二段思考：再深入推敲。",
    "这是思考之后的正文 C。",
]

# 多思考段分轮夹具：思考段的折叠范围必须是一轮（一条助手消息），
# 不能是整场会话。第 1/2/3 轮的思考段数为 1/2/3，各段末句是唯一锚点。
ROUND_RUNS = [1, 2, 3]


def round_anchor(round_no: int, run_no: int) -> str:
    return f"第{round_no}轮第{run_no}段思考：这里推敲第{round_no}轮的第{run_no}个要点。"


def build_rounds(base: int) -> list[dict]:
    """三轮会话，每轮的消息内分别有 1/2/3 段思考，用于验收 latest 的折叠范围。"""
    lines: list[dict] = [
        {
            "type": "session",
            "version": 3,
            "id": str(uuid.uuid4()),
            "timestamp": iso(base),
            "cwd": CWD,
        }
    ]
    parent = None
    for round_no, run_count in enumerate(ROUND_RUNS, start=1):
        user_ms = base + round_no * 100_000
        user_id = uuid.uuid4().hex[:8]
        lines.append(
            entry(
                user_id,
                parent,
                user_ms,
                {
                    "role": "user",
                    "content": [{"type": "text", "text": f"第{round_no}轮提问"}],
                    "timestamp": user_ms,
                },
            )
        )
        content: list[dict] = []
        for run_no in range(1, run_count + 1):
            content.append({"type": "thinking", "thinking": round_anchor(round_no, run_no)})
            content.append({"type": "text", "text": f"第{round_no}轮第{run_no}段正文。"})
        assistant_id = uuid.uuid4().hex[:8]
        lines.append(
            entry(
                assistant_id,
                user_id,
                user_ms + 1_000,
                {
                    "role": "assistant",
                    "content": content,
                    "api": "openai-completions",
                    "provider": "magpie",
                    "model": "opencode-zen-free/deepseek-v4.1-flash-free",
                    "usage": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "reasoning": 0,
                        "totalTokens": 0,
                        "cost": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "total": 0,
                            "totalFromProvider": False,
                        },
                    },
                    "stopReason": "stop",
                    "timestamp": user_ms + 1_000,
                    "responseId": f"probe-round-{round_no}",
                    "rawStopReason": "stop",
                    "durationMs": 1_200,
                    "thinkingLevel": "high",
                },
            )
        )
        parent = assistant_id
    return lines


def build_interleaved(base: int) -> list[dict]:
    """单条消息内交错：text → thinking → text → thinking → text（正确 parentId 链）。

    用于验收「非思考正文必须显示」：回放后三段正文与两条思考标签行都应可见。
    注意 parentId 必须成链（user → assistant），否则 pi 回放器会静默跳过消息。
    """
    lines: list[dict] = [
        {
            "type": "session",
            "version": 3,
            "id": str(uuid.uuid4()),
            "timestamp": iso(base),
            "cwd": CWD,
        }
    ]
    user_ms = base
    user_id = uuid.uuid4().hex[:8]
    lines.append(
        entry(
            user_id,
            None,
            user_ms,
            {
                "role": "user",
                "content": [{"type": "text", "text": "交错演示"}],
                "timestamp": user_ms,
            },
        )
    )
    assistant_id = uuid.uuid4().hex[:8]
    content: list[dict] = []
    for block in INTERLEAVED:
        if block.startswith("第") and "思考" in block:
            content.append({"type": "thinking", "thinking": block})
        else:
            content.append({"type": "text", "text": block})
    lines.append(
        entry(
            assistant_id,
            user_id,
            user_ms + 1_000,
            {
                "role": "assistant",
                "content": content,
                "api": "openai-completions",
                "provider": "magpie",
                "model": "opencode-zen-free/deepseek-v4.1-flash-free",
                "usage": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "reasoning": 0,
                    "totalTokens": 0,
                    "cost": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0,
                        "totalFromProvider": False,
                    },
                },
                "stopReason": "stop",
                "timestamp": user_ms + 1_000,
                "responseId": "probe-interleaved",
                "rawStopReason": "stop",
                "durationMs": 1_200,
                "thinkingLevel": "high",
            },
        )
    )
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="输出会话文件路径")
    parser.add_argument("--turns", type=int, default=2, help="生成几条助手消息（1-2）")
    parser.add_argument(
        "--interleaved",
        action="store_true",
        help="生成单条消息内 text/thinking 交错结构（验收非思考正文显示）",
    )
    parser.add_argument(
        "--agentic",
        action="store_true",
        help="生成两轮用户提问、每轮内多条「思考+工具调用」助手消息的会话（验收 latest 按用户回合折叠）",
    )
    parser.add_argument(
        "--rounds",
        action="store_true",
        help="生成三轮、每轮 1/2/3 段思考的会话（验收 latest 折叠范围是一轮而非整场）",
    )
    args = parser.parse_args()

    base = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    if args.agentic:
        lines = build_agentic(base)
    elif args.rounds:
        lines = build_rounds(base)
    elif args.interleaved:
        lines = build_interleaved(base)
    else:
        lines = build(max(1, min(args.turns, len(TURNS))))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        for line in lines:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")
    if args.agentic:
        for round_no, iterations in AGENTIC_TURNS:
            for iteration in range(1, iterations + 1):
                print(f"round {round_no} step {iteration} anchor: {agentic_anchor(round_no, iteration)}")
    elif args.rounds:
        for round_no, run_count in enumerate(ROUND_RUNS, start=1):
            for run_no in range(1, run_count + 1):
                print(f"round {round_no} run {run_no} anchor: {round_anchor(round_no, run_no)}")
    elif args.interleaved:
        for block in INTERLEAVED:
            print(f"interleaved anchor: {block}")
    else:
        for index, turn in enumerate(TURNS[: len(lines) - 1]):
            print(f"turn {index + 1} anchor: {turn['anchor']}")
    print(f"session: {args.out}")


if __name__ == "__main__":
    main()

// latest 的折叠范围探针：一行只能代表「一轮」（一条助手消息），
// 不能报整场会话的累计段数与累计时长。
//
// 回放会话没有计时（历史消息不编造时长），段数标签在真实流式会话里才出现，
// 因此这一项用模块级计时直接验：先让一条 3 段思考的消息流式落账，
// 再让一条 1 段思考的消息流式落账。修前第二条会报 "(4 runs)"（整场累计），
// 修后不报段数（本轮只有 1 段）。
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";

const digest = await import("./index.ts");
void digest.default?.({ on: () => {}, registerCommand: () => {}, registerShortcut: () => {} });
await new Promise((resolve) => setTimeout(resolve, 300));
// 模式必须在扩展初始化之后设定：初始化会从配置文件读回上次的模式
digest.setModeForTest("latest");
digest.resetForTest();

try {
	initTheme();
} catch {
	/* 主题已在 pi 里初始化过 */
}

const message = (runs, timestamp, tag) => ({
	role: "assistant",
	content: Array.from({ length: runs }, (_, index) => ({
		type: "thinking",
		thinking: `${tag}第${index + 1}段：这里推敲要点。`,
	})),
	timestamp,
	stopReason: null,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

const now = Date.now();
const first = message(3, now, "A");
const second = message(1, now + 1_000, "B");

// 两条都按流式渲染：只有流式才会落计时起点
const firstComponent = new AssistantMessageComponent(first, true, undefined, "", 1, []);
firstComponent.updateContent(first, true);
const firstLine = digest.buildLine(firstComponent, first);

const secondComponent = new AssistantMessageComponent(second, true, undefined, "", 1, []);
secondComponent.updateContent(second, true);
const secondLine = digest.buildLine(secondComponent, second);

const plain = (line) => String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const okFirst = /\(3 runs\)/.test(plain(firstLine));
const okSecond = !/runs\)/.test(plain(secondLine));

console.log(`第一条（3 段）：${plain(firstLine)}`);
console.log(`第二条（1 段）：${plain(secondLine)}`);
console.log(okFirst ? "ok   本轮段数按本消息统计（3 段）" : "FAIL 第一条没报出本轮 3 段");
console.log(okSecond ? "ok   第二条不累计上一轮的段数" : "FAIL 第二条把整场会话的段数累计进来");
process.exit(okFirst && okSecond ? 0 : 1);
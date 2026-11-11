// 回合折叠探针：latest 的折叠单位必须是「一个用户回合」，不是单条助手消息。
//
// 真实会话的形态是「思考 + 工具调用」反复多次，每轮一次工具就是一条独立助手消息。
// 按消息折叠时，一个用户回合会冒出十几行（大师 2026-11-11 报障）。
//
// 这里按时间顺序喂两条同回合的助手消息，断言：
//   1) 第一条先占住那一行（它当时是本回合最后一条）；
//   2) 第二条出现后，第一条的行被自动重绘掉（带行资格转移）；
//   3) 第二条的行报本回合累计段数「(2 runs)」；
//   4) 下一个用户回合出现后，本回合的行照旧保留（新回合不清旧回合的行）。
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";

const digest = await import("./index.ts");
void digest.default?.({ on: () => {}, registerCommand: () => {}, registerShortcut: () => {} });
await new Promise((resolve) => setTimeout(resolve, 300));
digest.setModeForTest("latest");
digest.resetForTest();

try {
	initTheme();
} catch {
	/* 主题已在 pi 里初始化过 */
}

const strip = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const thinkingLine = (component) =>
	strip(component.render(140)).split("\n").filter((line) => line.includes("Thought") || line.includes("Thinking"));

const t0 = Date.now();
const message = (runs, timestamp, tag) => ({
	role: "assistant",
	content: [
		...Array.from({ length: runs }, (_, index) => ({
			type: "thinking",
			thinking: `${tag}第${index + 1}段：这里推敲要点。`,
		})),
	],
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

const first = message(1, t0 + 1_000, "A");
const second = message(1, t0 + 2_000, "B");
const third = message(1, t0 + 3_000, "C");

// 用户回合边界靠会话条目判定：先是 user，再逐条加入助手消息
const entries = [
	{ type: "message", id: "u1", message: { role: "user", timestamp: t0, content: [{ type: "text", text: "把这件事做完。" }] } },
	{ type: "message", id: "a1", message: first },
];
digest.setSessionEntriesForTest({ getEntries: () => entries });

const firstComponent = new AssistantMessageComponent(first, true, undefined, "", 1, []);
firstComponent.updateContent(first, true);
const firstBefore = thinkingLine(firstComponent);

const secondComponent = new AssistantMessageComponent(second, true, undefined, "", 1, []);
// 第二条助手消息进入本回合：带行资格应当从第一条转给第二条
entries.push({ type: "message", id: "a2", message: second });
secondComponent.updateContent(second, true);
// 被挤掉的那条要自己重绘，否则旧行会留在屏幕上
await new Promise((resolve) => setTimeout(resolve, 50));

const firstAfter = thinkingLine(firstComponent);
const secondAfter = thinkingLine(secondComponent);

// 下一个用户回合出现：新回合只影响自己，不能把旧回合的行收掉
const thirdComponent = new AssistantMessageComponent(third, true, undefined, "", 1, []);
entries.push({ type: "message", id: "u2", message: { role: "user", timestamp: t0 + 2_500, content: [{ type: "text", text: "下一件事。" }] } });
entries.push({ type: "message", id: "a3", message: third });
thirdComponent.updateContent(third, true);
await new Promise((resolve) => setTimeout(resolve, 50));
const secondAfterNextTurn = thinkingLine(secondComponent);
const thirdLine = thinkingLine(thirdComponent);

const okFirstBefore = firstBefore.length === 1;
const okHandover = firstAfter.length === 0;
const okSecond = secondAfter.length === 1 && /\(2 runs\)/.test(secondAfter[0]);
const okTurnIsolation = secondAfterNextTurn.length === 1 && thirdLine.length === 1;

console.log(`第一条（接管前）：${firstBefore[0] ?? "(无行)"}`);
console.log(`第一条（接管后）：${firstAfter[0] ?? "(无行，已重绘)"}`);
console.log(`第二条（本回合累计）：${secondAfter[0] ?? "(无行)"}`);
console.log(okFirstBefore ? "ok   回合末条先占住那一行" : "FAIL 第一条没画出行");
console.log(okHandover ? "ok   带行资格转移后旧行被重绘掉" : "FAIL 旧行留在屏幕上");
console.log(okSecond ? "ok   本回合段数累计为 2" : "FAIL 本回合段数不对");
console.log(`第二轮的行：${thirdLine[0] ?? "(无行)"}`);
console.log(okTurnIsolation ? "ok   新回合不清旧回合的行" : "FAIL 新回合把旧回合的行收掉了");
process.exit(okFirstBefore && okHandover && okSecond && okTurnIsolation ? 0 : 1);
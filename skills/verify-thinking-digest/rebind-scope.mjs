// 进程内切换会话的恢复探针。
//
// pi 在进程内换会话（/resume、会话选择器、fork）时的顺序是「先渲染历史，再绑定扩展」。
// 渲染那一步扩展还没拿到 sessionManager，恢复不到落盘的时长，历史行会定稿成
// `Thought (N runs)`；绑定后如果没人重绘，那行就一直是错的。
//
// 这里复刻该顺序：先在没有会话条目的情况下渲染，再触发 session_start，
// 断言恢复后旧行被重绘成带时长的样子。
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";

const digest = await import("./index.ts");
const handlers = new Map();
void digest.default?.({
	on: (name, handler) => {
		handlers.set(name, handler);
		return () => {};
	},
	registerCommand: () => {},
	registerShortcut: () => {},
	appendEntry: () => {},
});
await new Promise((resolve) => setTimeout(resolve, 300));
digest.setModeForTest("latest");
digest.resetForTest();

try {
	initTheme();
} catch {
	/* 主题已在 pi 里初始化过 */
}

const strip = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const thoughtLine = (component) =>
	strip(component.render(140))
		.split("\n")
		.filter((line) => line.includes("Thought") || line.includes("Thinking")); 

const t0 = Date.now();
const message = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "第一段：这里推敲要点，结论是四十二。" }, { type: "text", text: "答案。" }],
	timestamp: t0 + 1_000,
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const entries = [
	{ type: "message", id: "u1", message: { role: "user", timestamp: t0, content: [{ type: "text", text: "提问。" }] } },
	{ type: "message", id: "a1", message },
	{ type: "custom", id: "c1", customType: "thinking-digest-timing", data: { ts: message.timestamp, ms: 1_000 } },
];

// 绑定前渲染：扩展手上没有会话条目
digest.setSessionEntriesForTest(undefined);
const component = new AssistantMessageComponent(message, true, undefined, "", 1, []);
component.updateContent(message, false);
const beforeBind = thoughtLine(component);

// 绑定：session_start 带上会话管理器，扩展应当恢复时长并重绘已渲染的历史
const startHandler = handlers.get("session_start");
if (typeof startHandler !== "function") {
	console.log("FAIL 扩展没有注册 session_start");
	process.exit(1);
}
await startHandler({ type: "session_start", reason: "resume" }, {
	sessionManager: { getEntries: () => entries },
	ui: { notify: () => {} },
	mode: "tui",
});
await new Promise((resolve) => setTimeout(resolve, 50));
const afterBind = thoughtLine(component);

const okBefore = beforeBind.length === 1 && !/Thought for/.test(beforeBind[0]);
const okAfter = afterBind.length === 1 && /Thought for 1s/.test(afterBind[0]);

console.log(`绑定前：${beforeBind[0] ?? "(无行)"}`);
console.log(`绑定后：${afterBind[0] ?? "(无行)"}`);
console.log(okBefore ? "ok   绑定前确实拿不到时长（复刻 pi 的渲染顺序）" : "FAIL 绑定前就带时长，探针没有复刻出该顺序");
console.log(okAfter ? "ok   绑定后旧行被重绘成 Thought for 1s" : "FAIL 绑定后旧行没有重绘，停在无时长状态");
process.exit(okBefore && okAfter ? 0 : 1);
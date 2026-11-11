// 无思考消息的正文安全探针：pi-omp-theme 会把 hiddenThinkingLabel 清成空串，
// thinking-digest 需要给隐藏行补占位标签；占位标签一旦能被正文子串命中，
// 无思考消息的整段正文就会被当成标签行清掉。
//
// 复现：prose-only 消息 + 正文含省略号 + label 为空 → 修前正文被清空。
// 直接 node prose-safety.mjs 运行（无需模型、无需 tmux）。
import { initTheme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

const PROSE =
	"大师，查清了，虚惊一场——**总结并没有消失，改坏也不成立**，原因是会话正运行在 `latest` 模式（内联 `…/sessions/…` 路径）。";

const message = {
	role: "assistant",
	content: [{ type: "text", text: PROSE }],
	timestamp: Date.now(),
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

const digest = await import("./index.ts");
void digest.default?.({ on: () => {}, registerCommand: () => {}, registerShortcut: () => {} });
await new Promise((resolve) => setTimeout(resolve, 300));

try {
	initTheme();
} catch {
	/* 主题已在 pi 里初始化过 */
}

const component = new AssistantMessageComponent(message, true, undefined, "", 1, []);
component.hiddenThinkingLabel = "";
component.updateContent(message, false);

const plain = component
	.render(120)
	.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
	.join("\n");

const visible = plain.includes("虚惊一场");
console.log(visible ? "ok   无思考消息的正文完整保留" : "FAIL 无思考消息的正文被清空");
if (!visible) {
	console.log("--- 实际渲染 ---");
	console.log(plain.trim() === "" ? "(空)" : plain);
}
process.exit(visible ? 0 : 1);
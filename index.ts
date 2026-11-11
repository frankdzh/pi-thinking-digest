/**
 * thinking-digest — 接管隐藏思考那一行，支持三种显示模式
 *
 * 背景：
 *   隐藏思考时（`hideThinkingBlock: true`），pi 只在每条助手消息里画一行标签。
 *   宿主（pi-pretty / pi-omp-theme）各写各的，还互相覆盖。本扩展把这一行完整
 *   接管：自己算耗时、自己拼摘要、自己决定画不画。
 *
 * 三种模式（`/td-mode` 或热键 Ctrl+Shift+K 循环切换，存 ~/.pi/agent/thinking-digest.json）：
 *   hide    全隐藏：连标签行一起删掉，与 pi-omp-theme 清空标签的老效果一致
 *   digest  默认：每条消息一行 `Thought for 3s (Ctrl+T to expand) · 摘要`
 *   latest  回合折叠：每个用户回合只留一行（本回合多段思考并成这一行，
 *           工具循环里每次迭代的助手消息不再各占一行）；折叠范围是一个回合，
 *           既不是整场会话，也不是单条助手消息
 *
 * 机制：
 *   补丁运行时 AssistantMessageComponent.prototype.updateContent：
 *   1) 先保证 hiddenThinkingLabel 非空（否则 pi 的隐藏分支直接 continue，不建 Text）；
 *   2) 让宿主正常渲染；
 *   3) 找到那行 Text，按模式改写成自己的整行文本，或连同前面的 Spacer 一起删掉。
 *
 *   **必须拿运行时那份类**：pi 的 bin 是 dist/bundle/cli.js，TUI 类被内联进
 *   chunks/chunk-*.js，与扩展 import "@earendil-works/pi-coding-agent" 拿到的
 *   dist/index.js 是两份不同的类对象。只补包副本对真实聊天组件零效果
 *   （tool-tail-fold 也踩过同一个坑）。故这里扫描 chunk 的 export 列表，
 *   import() 同一个 URL，靠 ESM 模块缓存拿到 pi 正在用的那份。
 *
 * 耗时口径：本进程内从「首次看到该消息在流式思考」到「思考段结束」的墙钟，
 *   与 pi-pretty / pi-omp-theme 同源限制——历史会话恢复的消息没有起点，
 *   只显示 `Thought (… to expand) · 摘要`，不编造时长。
 *
 * 降级：找不到运行时类或补丁抛错 → 宿主退回原生显示，不影响工具与正文。
 *
 * 可调项：
 *   THINKING_DIGEST_OFF=1        完全关闭本扩展
 *   THINKING_DIGEST_MAX_WIDTH    摘要最大显示列数（默认 52）
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DISABLED = process.env.THINKING_DIGEST_OFF === "1";
const MAX_DIGEST_WIDTH = Math.max(12, Number(process.env.THINKING_DIGEST_MAX_WIDTH ?? 52) || 52);
const SEPARATOR = " · ";
const MAX_CACHE_ENTRIES = 200;
const PATCH_MARK = Symbol.for("thinking-digest.patched");
/** 补丁版本：改补丁逻辑必须 +1，/reload 后靠它识别旧闭包残留并重包 */
const PATCH_VERSION = 4;
type PatchStamp = { version: number; original: unknown };
/** 思考中的行首动画帧：与 pi 原生 Working 指示器同款 braille 序列 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type Mode = "hide" | "digest" | "latest";
const MODES: readonly Mode[] = ["hide", "digest", "latest"];

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

interface AssistantMessage {
	role?: string;
	content?: ContentBlock[];
	timestamp?: number;
}

interface HiddenComponent {
	hiddenThinkingLabel?: unknown;
	isStreaming?: unknown;
	lastMessage?: AssistantMessage;
	contentContainer?: { children?: unknown[] };
	updateContent?: (message: unknown, ...rest: unknown[]) => unknown;
}

interface Timing {
	start: number;
	end?: number;
}

/** 会话条目里存放思考墙钟的 customType（不进上下文、随会话文件走） */
const TIMING_ENTRY_TYPE = "thinking-digest-timing";

/** 可注入时钟：测试拨钟用，生产环境就是 Date.now */
export let now: () => number = () => Date.now();
/** 仅测试用：替换时钟。返回还原函数 */
export function setNowForTest(fn: () => number): () => void {
	const restore = now;
	now = fn;
	return () => {
		now = restore;
	};
}

let mode: Mode = "digest";
/** 仅测试用：直接设置模式，不落盘 */
export function setModeForTest(next: Mode): void {
	mode = next;
}
/** 仅测试用：清空计时与摘要缓存 */
export function resetForTest(): void {
	timings.clear();
	persistedTimings.clear();
	digestCache.clear();
	timingsRestored = false;
}

/** 诊断用：最近一次生成的摘要 */
let lastDigest = "";

/** 摘要缓存：键取消息 timestamp，完成后才写入，避免增量思考拿到旧摘要 */
const digestCache = new Map<number, string>();
/** 每消息思考墙钟（本进程内） */
const timings = new Map<number, Timing>();
/** 已写入会话的时长（或已从会话恢复的），避免重复落盘 */
const persistedTimings = new Set<number>();
/** 写会话条目的通道（由宿主注入） */
let appendTiming: ((ts: number, ms: number) => void) | undefined;
/** 已注入补丁的消息组件（模式切换时统一重绘） */
const liveComponents = new Set<HiddenComponent>();
/** 诊断：模块实例标识（排查“命令与补丁不在同一份模块”的双加载） */
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
/** 诊断：patchedUpdate 实际被调用的次数与运行时的原型方法名 */
let patchCalls = 0;
let patchedProtoName = "-";
/** 防重入：刷新旧组件会再次进入 updateContent */
let refreshing = false;
/** 思考可见性切换键，运行时装好（失败用 "Ctrl+T"） */
let toggleKey = "Ctrl+T";
/** 当前动画帧索引 */
let spinnerFrame = 0;

// ─── 配置 ─────────────────────────────────────────────────────────────────────

function agentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function configPath(): string {
	return join(agentDir(), "thinking-digest.json");
}

function loadMode(): Mode {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { mode?: unknown };
		return MODES.includes(parsed.mode as Mode) ? (parsed.mode as Mode) : "digest";
	} catch {
		return "digest";
	}
}

function saveMode(next: Mode): void {
	try {
		writeFileSync(configPath(), `${JSON.stringify({ mode: next }, null, 2)}\n`, "utf8");
	} catch {
		/* 落盘失败不影响本次会话 */
	}
}

// ─── 摘要 ─────────────────────────────────────────────────────────────────────

/** 过渡句特征：思考里的「接下来我需要…」不是结论，跳过 */
const TRANSITION_RE =
	/^(let me|let's|now\b|then\b|next\b|okay|ok\b|so\b|i need|i'll|i will|i should|i want|wait\b|hmm\b|alright|first\b|接下来|然后|现在|好的|那么|嗯|先|下一步)/i;

/** 去掉 markdown 标记与代码块，压成一行；保留单下划线，避免改坏标识符 */
function stripMarkup(raw: string): string {
	return raw
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/^[ \t]*(?:[-*+>]+|\d+[.)])\s*/gm, " ")
		.replace(/\*\*|__|~~/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 切句：中文标点直接断，英文句号后必须跟空白，避免切坏 3.5 / v1.2 */
function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[。！？；])|(?<=[.!?;])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

/** 等宽字符记 2 列（CJK / 全角 / emoji），其余记 1 列 */
function charWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	return code >= 0x1100 &&
		(code <= 0x115f ||
			code === 0x2329 ||
			code === 0x232a ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1f64f) ||
			(code >= 0x20000 && code <= 0x3fffd))
		? 2
		: 1;
}

/** 按显示列数截断，超宽加省略号 */
function truncate(text: string, maxWidth: number): string {
	let width = 0;
	let out = "";
	for (const char of text) {
		const next = width + charWidth(char);
		if (next > maxWidth) return `${out}…`;
		width = next;
		out += char;
	}
	return text;
}

/**
 * 抽取式摘要：优先取最后一句「实质句」（够长、不是过渡句），
 * 因为思考的结论通常落在末尾；实在没有就用末句。
 */
export function digestThinking(text: string, maxWidth = MAX_DIGEST_WIDTH): string {
	const cleaned = stripMarkup(text);
	if (!cleaned) return "";
	const sentences = splitSentences(cleaned);
	if (sentences.length === 0) return truncate(cleaned, maxWidth);
	const substantive = sentences.filter(
		(sentence) => sentence.length >= 10 && !TRANSITION_RE.test(sentence),
	);
	const pick = substantive.at(-1) ?? sentences.at(-1) ?? cleaned;
	return truncate(pick, maxWidth);
}

/** 汇总消息里的全部思考文本 */
function collectThinking(content: ContentBlock[]): string {
	return content
		.filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
		.map((block) => block.thinking as string)
		.join("\n\n");
}

function hasThinking(content: ContentBlock[]): boolean {
	return content.some((block) => block?.type === "thinking");
}

/** 本条消息里各段思考的文本（一段一行，顺序即渲染顺序） */
function thinkingTexts(content: ContentBlock[]): string[] {
	return content
		.filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
		.map((block) => block.thinking as string);
}

// ─── 回合折叠基准（latest 模式用）──────────────────────────────────────────────
//
// latest 的折叠单位是「一个用户回合」，不是一个助手消息。
// 真实会话里一个回合往往是「思考 + 工具调用」反复多次，每轮一次工具就是一条
// 独立的助手消息；若按消息折叠，一个回合会冒出十几行（大师 2026-11-11 报障）。
// 故按会话条目里最近的 user 消息划分回合，同一回合里只留最后一条带思考的助手消息。

interface TurnFold {
	/** 本回合「带行」的那条助手消息（最后一条有思考的） */
	carrierTs: number;
	/** 本回合其它助手消息的思考段数合计 */
	priorRuns: number;
	/** 本回合其它助手消息的思考墙钟合计（历史恢复的消息无起点则不计） */
	priorMs: number;
	priorHasMs: boolean;
}

let sessionEntries: SessionEntriesSource | undefined;
const turnFolds = new Map<number, TurnFold>();
let turnFoldKey = "";

function forgetTurnFolds(): void {
	turnFoldKey = "";
	turnFolds.clear();
}

/** 仅测试用：注入会话条目来源（省略则按无会话信息处理，退回按消息折叠） */
export function setSessionEntriesForTest(source: SessionEntriesSource | undefined): void {
	sessionEntries = source;
	forgetTurnFolds();
}

/** 重建或复用回合索引；失效键取条目数与末条 id（流式期间条目被原地改写，条目数不变） */
function ensureTurnFolds(): Map<number, TurnFold> {
	const entries = sessionEntries?.getEntries?.();
	if (!Array.isArray(entries) || entries.length === 0) return turnFolds;
	const key = `${entries.length}:${entries[entries.length - 1]?.id ?? ""}`;
	if (key === turnFoldKey) return turnFolds;

	// 重建前记下旧带行集：带行资格被新消息接管后，旧的那一行必须重绘才会消失
	const before = new Map(turnFolds);
	turnFolds.clear();
	let acc: Array<{ ts: number; runs: number }> = [];
	const flush = (): void => {
		if (acc.length === 0) return;
		const carrier = acc[acc.length - 1];
		let priorRuns = 0;
		let priorMs = 0;
		let priorHasMs = false;
		for (const item of acc) {
			if (item.ts === carrier.ts) continue;
			priorRuns += item.runs;
			const timing = timings.get(item.ts);
			if (timing) {
				priorMs += Math.max(0, (timing.end ?? now()) - timing.start);
				priorHasMs = true;
			}
		}
		const fold: TurnFold = { carrierTs: carrier.ts, priorRuns, priorMs, priorHasMs };
		for (const item of acc) turnFolds.set(item.ts, fold);
		acc = [];
	};
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message.timestamp !== "number") continue;
		if (message.role === "user") {
			flush();
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (!hasThinking(message.content)) continue;
		acc.push({ ts: message.timestamp, runs: thinkingTexts(message.content).length });
	}
	flush();
	turnFoldKey = key;

	// 同一回合里带行资格往后转移时，被挤掉的那条消息此刻已经渲染过自己的行；
	// 没有任何机制会重绘它，所以这里主动补一次（延到微任务，避开渲染递归）。
	const stale = new Set<number>();
	for (const [ts, fold] of before) {
		if (fold.carrierTs === ts) stale.add(ts);
	}
	for (const [ts, fold] of turnFolds) {
		if (fold.carrierTs === ts) stale.delete(ts);
	}
	if (stale.size > 0) queueMicrotask(() => repaintMessages(stale));
	return turnFolds;
}

/** 重绘指定时间戳的消息组件（latest 模式折叠位置转移时用） */
function repaintMessages(stamps: Set<number>): void {
	if (refreshing) return;
	refreshing = true;
	try {
		for (const component of liveComponents) {
			const stamp = component.lastMessage?.timestamp;
			if (typeof stamp === "number" && stamps.has(stamp)) refreshComponent(component);
		}
	} finally {
		refreshing = false;
	}
}

/** 思考段是否已结束：thinking 之后出现了正文或工具调用 */
function thinkingSettled(content: ContentBlock[]): boolean {
	let lastThinking = -1;
	for (let index = 0; index < content.length; index++) {
		if (content[index]?.type === "thinking") lastThinking = index;
	}
	if (lastThinking < 0) return false;
	return content.slice(lastThinking + 1).some(
		(block) =>
			(block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) ||
			block?.type === "toolCall",
	);
}

function digestOf(message: AssistantMessage, streaming: boolean): string {
	const content = message?.content;
	// 流式中也要出摘要：思考文本还在增长，每次按当时的末句重算（不缓存）。
	if (!Array.isArray(content) || !hasThinking(content)) return "";
	const key = typeof message.timestamp === "number" ? message.timestamp : undefined;
	if (key !== undefined && !streaming) {
		const cached = digestCache.get(key);
		if (cached !== undefined) return cached;
	}
	const digest = digestThinking(collectThinking(content));
	lastDigest = digest;
	if (key !== undefined && !streaming) {
		if (digestCache.size >= MAX_CACHE_ENTRIES) digestCache.clear();
		digestCache.set(key, digest);
	}
	return digest;
}

// ─── 耗时 ─────────────────────────────────────────────────────────────────────

/** 墙钟格式化（秒级）：<60s 用 s，再长用 m ss。与 pi-pretty 的思考标签口径一致。 */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * 记录/读取一条消息的思考墙钟。
 * 只在「流式中首次看到」记起点；历史消息（非流式且无记录）不编造时长。
 */
function trackTiming(message: AssistantMessage, streaming: boolean): number | undefined {
	const content = message?.content;
	const key = typeof message.timestamp === "number" ? message.timestamp : undefined;
	if (key === undefined || !Array.isArray(content) || !hasThinking(content)) return undefined;
	ensureTimingsRestored();
	const settled = thinkingSettled(content);
	let timing = timings.get(key);
	if (!timing) {
		if (!streaming) return undefined; // 历史消息没有起点
		timing = { start: now() };
		timings.set(key, timing);
		if (settled) timing.end = now();
	} else if (settled && timing.end === undefined) {
		timing.end = now();
	}
	// 流式中返回「到现在为止」，行上的数字才会实时走；完成后返回冻结值。
	return Math.max(0, (timing.end ?? now()) - timing.start);
}

/**
 * 把已定稿的思考墙钟写进会话（custom 条目）。
 * 只在消息结束时写，避开流式中的会话写入；恢复来的条目不重写。
 */
function persistTiming(message: AssistantMessage): void {
	const key = typeof message?.timestamp === "number" ? message.timestamp : undefined;
	if (key === undefined) return;
	const timing = timings.get(key);
	if (!timing || timing.end === undefined || persistedTimings.has(key)) return;
	persistedTimings.add(key);
	appendTiming?.(key, Math.max(0, timing.end - timing.start));
}

/** 恢复只做一次；会话条目晚于 session_start 就绪时由首次渲染补做 */
let timingsRestored = false;

function ensureTimingsRestored(): void {
	if (timingsRestored) return;
	const entries = sessionEntries?.getEntries?.();
	if (!Array.isArray(entries) || entries.length === 0) return;
	restoreTimings(entries);
	timingsRestored = true;
}

/** 从会话条目恢复墙钟：重启/回放时那行才能继续报 `Thought for Ns` */
function restoreTimings(entries: ReturnType<NonNullable<SessionEntriesSource["getEntries"]>> | undefined): void {
	if (!Array.isArray(entries)) return;
	for (const entry of entries) {
		const custom = entry as { type?: string; customType?: string; data?: { ts?: unknown; ms?: unknown } };
		if (custom?.type !== "custom" || custom.customType !== TIMING_ENTRY_TYPE) continue;
		const ts = custom.data?.ts;
		const ms = custom.data?.ms;
		if (typeof ts !== "number" || typeof ms !== "number" || !Number.isFinite(ms)) continue;
		// 本进程已实测过的消息优先（恢复值只补历史缺口）
		if (timings.has(ts)) continue;
		// 起点记 0，只保留已定稿的墙钟（end - start 就是 ms）
		timings.set(ts, { start: 0, end: ms });
		persistedTimings.add(ts);
	}
}

// ─── 整行文本 ─────────────────────────────────────────────────────────────────

/**
 * 按当前模式决定这一行显示什么；undefined 表示删掉整行。
 * `digestOverride` 用于给同一条消息里的某一思考段单独出摘要（digest 模式每段一行）。
 */
export function buildLine(
	component: HiddenComponent,
	message: AssistantMessage,
	digestOverride?: string,
): string | undefined {
	if (mode === "hide") return undefined;
	const content = message?.content;
	if (!Array.isArray(content) || !hasThinking(content)) return undefined;

	// 每次渲染都记一笔：起点必须在流式第一次出现时落账，不能等到思考结束
	const ownDuration = trackTiming(message, component.isStreaming === true);
	const digest = digestOverride ?? digestOf(message, component.isStreaming === true);
	const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
	const streaming = !thinkingSettled(content);

	// latest 模式：折叠单位是「一个用户回合」（本消息所在的那一轮），
	// 不是整场会话，也不是单条助手消息。
	const fold =
		mode === "latest" && typeof message.timestamp === "number"
			? ensureTurnFolds().get(message.timestamp)
			: undefined;
	// 同一回合里只留带行的那条（最后一条有思考的助手消息），其余消息的行全部删掉
	if (fold && fold.carrierTs !== message.timestamp) return undefined;

	let durationMs = ownDuration;
	let runs = 0;
	if (mode === "latest") {
		const own = thinkingTexts(content).length;
		runs = own + (fold?.priorRuns ?? 0);
		if (fold?.priorHasMs) durationMs = (ownDuration ?? 0) + fold.priorMs;
	}

	const elapsed = durationMs === undefined ? "" : ` ${formatDuration(durationMs)}`;
	const runsTag = runs > 1 ? ` (${runs} runs)` : "";

	// 思考进行中：行首动画 + 实时计时（现在分词）+ 当前摘要（不带展开提示，展开是完成后的动作）
	if (streaming) {
		return `${frame} Thinking${elapsed}${runsTag}${digest ? `${SEPARATOR}${digest}` : ""}`;
	}

	// 思考结束：动画撤下，换完成时 `Thought for 3s`，补上 Ctrl+T 提示；
	// 历史消息没有起点（不编造时长）时只剩 `Thought (… to expand)`，不带 for。
	const settled = durationMs === undefined ? "Thought" : "Thought for";
	return `${settled}${elapsed}${runsTag} (${toggleKey} to expand)${digest ? `${SEPARATOR}${digest}` : ""}`;
}

// ─── 注入 ─────────────────────────────────────────────────────────────────────

/** 递归解包 MouseRegion / 装饰包装，拿到真正承载文字的 Text 组件 */
function unwrapText(node: unknown): { text: string; setText: (text: string) => void } | undefined {
	let current = node as { child?: unknown; text?: unknown; setText?: unknown } | undefined;
	for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
		if (typeof current.setText === "function" && typeof current.text === "string") {
			return current as { text: string; setText: (text: string) => void };
		}
		current = current.child as typeof current;
	}
	return undefined;
}

/** pi-tui Spacer 的形态：只暴露 setLines */
function isSpacer(node: unknown): boolean {
	return typeof (node as { setLines?: unknown } | undefined)?.setLines === "function";
}

/**
 * 隐藏那一行：**不删数组元素**，只把文本清空、把前面的 Spacer 压成 0 行。
 * 直接 splice 会让宿主与其它扩展缓存的 children 索引失效（pi-pretty 的分组、
 * tool-tail-fold 的 render 包装都按索引取组件），越界后 map 会拿到 undefined，
 * 下一帧渲染就是 `child.render is not a function`。长度不变才安全。
 */
function removeRow(children: unknown[], index: number): void {
	const text = unwrapText(children[index]);
	text?.setText("");
	if (index > 0 && isSpacer(children[index - 1])) {
		(children[index - 1] as { setLines?: (lines: number) => void }).setLines?.(0);
	}
}

/**
 * 占位标签：回放与 pi-omp-theme 都会把 hiddenThinkingLabel 清成空串，
 * 而 pi 的隐藏分支见 label 为空就不建那一行（扩展便无行可接管），所以要补一个。
 *
 * 占位符必须是正文永远不可能包含的串。早期用「…」，而正文里的省略号随处可见，
 * 匹配命中就把无思考消息的整段正文当标签行清掉（2026-11-11 大师报障）。
 */
const HIDDEN_LABEL_SENTINEL = "\u2063thinking-digest\u2063";

/** 保证隐藏分支能建出 Text（label 为空时 pi 会直接跳过这一行） */
function ensureLabel(component: HiddenComponent): string {
	const current = component.hiddenThinkingLabel;
	if (typeof current === "string" && current.trim().length > 0) return current;
	component.hiddenThinkingLabel = HIDDEN_LABEL_SENTINEL;
	return HIDDEN_LABEL_SENTINEL;
}

/** 宿主渲染完成后，按模式改写或删除那一行 */
export function applyLine(component: HiddenComponent, message: AssistantMessage, label: string): void {
	const content = message?.content;
	// 没有思考块的消息：pi 根本不画这一行，正文里也不能去找标签
	if (!Array.isArray(content) || !hasThinking(content)) return;
	// 计时与显示模式无关：hide 模式下也要记账，否则切到 latest 时既无时长也无落盘
	trackTiming(message, component.isStreaming === true);
	const children = component.contentContainer?.children;
	if (!Array.isArray(children)) return;

	// 每段思考都由 pi 画一行，按渲染顺序收集，下标即段号
	const rows: Array<{ index: number; text: { text: string; setText: (text: string) => void } }> = [];
	for (let index = children.length - 1; index >= 0; index--) {
		const text = unwrapText(children[index]);
		if (text && text.text.includes(label)) rows.push({ index, text });
	}
	rows.reverse();
	if (rows.length === 0) return;

	const line = buildLine(component, message);
	if (line === undefined) {
		for (const row of rows) removeRow(children, row.index);
		return;
	}

	if (mode === "latest") {
		const keep = rows[rows.length - 1];
		for (const row of rows) {
			if (row !== keep) removeRow(children, row.index);
		}
		const decorated = keep.text.text.split(label).join(line);
		if (decorated !== keep.text.text) keep.text.setText(decorated);
		return;
	}

	// digest：每段各显示自己的摘要（多段时不重复同一句）
	const texts = thinkingTexts(content);
	for (const [index, row] of rows.entries()) {
		const own = texts[index];
		const ownLine = own === undefined ? line : buildLine(component, message, digestThinking(own));
		if (ownLine === undefined) removeRow(children, row.index);
		else {
			const decorated = row.text.text.split(label).join(ownLine);
			if (decorated !== row.text.text) row.text.setText(decorated);
		}
	}
}

/** 让单个组件重新按当前基准渲染（会再次进入 patchedUpdate） */
function refreshComponent(component: HiddenComponent): void {
	const message = component.lastMessage;
	if (!message || typeof component.updateContent !== "function") return;
	try {
		component.updateContent(message, component.isStreaming === true);
	} catch {
		/* 单个组件刷新失败不影响其他 */
	}
}

/** 模式切换后重绘所有已托管组件，让新规则立即生效 */
function refreshAllComponents(): void {
	if (refreshing) return;
	refreshing = true;
	try {
		for (const component of liveComponents) refreshComponent(component);
	} finally {
		refreshing = false;
	}
}

// ─── 运行时类 ─────────────────────────────────────────────────────────────────

/** 收集可能的 bundle chunks 目录（pi 的安装形态会变，多路尝试） */
function candidateChunkDirs(): string[] {
	const dirs = new Set<string>();
	const entry = typeof process.argv[1] === "string" ? process.argv[1] : "";
	if (entry) {
		dirs.add(join(dirname(entry), "chunks"));
		try {
			dirs.add(join(dirname(realpathSync(entry)), "chunks"));
		} catch {
			/* 忽略 */
		}
	}
	try {
		const resolved = (import.meta as { resolve?: (spec: string) => string }).resolve?.(
			"@earendil-works/pi-coding-agent",
		);
		if (typeof resolved === "string" && resolved.startsWith("file:")) {
			dirs.add(join(dirname(dirname(fileURLToPath(resolved))), "dist", "bundle", "chunks"));
		}
	} catch {
		/* 忽略 */
	}
	return [...dirs];
}

/** chunk 的 export 列表总在末尾，读到即可筛选 */
function readTail(path: string, bytes: number): string {
	const stat = statSync(path);
	const start = Math.max(0, stat.size - bytes);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(stat.size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** 找到运行时真正在用的 AssistantMessageComponent（可能多份，全部补上） */
async function findRuntimeClasses(): Promise<unknown[]> {
	const found = new Set<unknown>();
	for (const dir of candidateChunkDirs()) {
		if (!existsSync(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir).filter((name) => name.endsWith(".js"));
		} catch {
			continue;
		}
		for (const name of files) {
			const full = join(dir, name);
			let tail: string;
			try {
				tail = readTail(full, 32 * 1024);
			} catch {
				continue;
			}
			// 只在 export 列表里带 AssistantMessageComponent 的 chunk 才可能是目标
			if (!/export\{[^}]*\bAssistantMessageComponent\b/.test(tail)) continue;
			try {
				const module = (await import(pathToFileURL(full).href)) as {
					AssistantMessageComponent?: unknown;
				};
				if (typeof module.AssistantMessageComponent === "function") {
					found.add(module.AssistantMessageComponent);
				}
			} catch {
				/* 导入失败不致命 */
			}
		}
		if (found.size > 0) break;
	}
	// pi 的 bundle 与包入口（dist/index.js）各持一份类副本：扩展 SDK import 到的
	// 是后者。两条路都补，避免宿主从另一份实例化。
	for (const dir of candidateChunkDirs()) {
		const pkgRoot = dirname(dirname(dirname(dir)));
		const indexPath = join(pkgRoot, "dist", "index.js");
		if (!existsSync(indexPath)) continue;
		try {
			const module = (await import(pathToFileURL(indexPath).href)) as {
				AssistantMessageComponent?: unknown;
			};
			if (typeof module.AssistantMessageComponent === "function") {
				found.add(module.AssistantMessageComponent);
			}
		} catch {
			/* 包入口导入失败不影响 chunk 路径 */
		}
	}
	return [...found];
}

/** 给运行时类补上「整行接管」逻辑 */
function patchClass(ctor: unknown): boolean {
	const proto = (ctor as { prototype?: Record<symbol, unknown> & { updateContent?: unknown } })
		?.prototype;
	if (!proto || typeof proto.updateContent !== "function") return false;
	const stamp = Object.hasOwn(proto, PATCH_MARK)
		? (proto[PATCH_MARK] as PatchStamp | undefined)
		: undefined;
	if (stamp?.version === PATCH_VERSION) return true;
	// 旧版本补丁残留（/reload 后类是同一个对象）：先还原原始实现再重包，
	// 避免继续跑旧闭包——只打布尔标记时这一步无法区分，/td-status 会假报“已补丁”。
	const original =
		stamp && typeof stamp.original === "function"
			? stamp.original
			: (proto.updateContent as (this: HiddenComponent, message: unknown, ...rest: unknown[]) => unknown);
	patchedProtoName = `${(proto.updateContent as { name?: string }).name || "?"} → patchedUpdate`;
	proto.updateContent = function patchedUpdate(this: HiddenComponent, message: unknown, ...rest: unknown[]) {
		patchCalls += 1;
		const label = ensureLabel(this);
		const result = original.call(this, message, ...rest);
		try {
			if (message && typeof message === "object") {
				const assistant = message as AssistantMessage;
				liveComponents.add(this);
				// 流式每个 delta 都会走到这里：顺带推进一帧。TUI 本来就会因 delta 重绘，
				// 不需要额外的定时器/重绘泵（setWidget 的工厂返回值契约曾把宿主搞崩）。
				if (this.isStreaming === true) {
					spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
				}
				applyLine(this, assistant, label);
			}
		} catch {
			// 摘要失败不影响宿主正常渲染
		}
		return result;
	};
	Object.defineProperty(proto, PATCH_MARK, {
		value: { version: PATCH_VERSION, original } satisfies PatchStamp,
	});
	return true;
}

// ─── 扩展入口 ─────────────────────────────────────────────────────────────────

interface CommandContext {
	ui?: { notify?: (message: string, type?: string) => void };
	sessionManager?: SessionEntriesSource;
}

/** 会话条目来源：只用到 getEntries()，不依赖 SDK 的完整类型 */
interface SessionEntriesSource {
	getEntries?: () => Array<{ id?: string; type?: string; message?: AssistantMessage }> | undefined;
}

export default function thinkingDigest(pi: {
	on: (event: string, handler: (...args: unknown[]) => void) => void;
	registerCommand: (
		name: string,
		definition: {
			description: string;
			handler: (args: unknown, ctx: CommandContext) => unknown;
		},
	) => void;
	registerShortcut: (
		shortcut: string,
		options: {
			description?: string;
			handler: (ctx: CommandContext) => unknown;
		},
	) => void;
	/** 往会话里写一条 custom 条目（用于持久化状态，不进上下文） */
	appendEntry?: (customType: string, data?: unknown) => unknown;
}): void {
	if (DISABLED) return;
	mode = loadMode();

	let patched = 0;
	let discoverState = "未开始";

	const install = async (): Promise<void> => {
		if (patched > 0) return;
		try {
			const classes = await findRuntimeClasses();
			// 扩展 SDK 入口是另一份类副本（pi 的 bundle 与 dist/index.js 不共享模块实例），
			// 一并补上，避免只补 chunk 而宿主走 SDK 那份。
			try {
				const sdk = (await import("@earendil-works/pi-coding-agent")) as {
					AssistantMessageComponent?: unknown;
				};
				if (typeof sdk.AssistantMessageComponent === "function" && !classes.includes(sdk.AssistantMessageComponent)) {
					classes.push(sdk.AssistantMessageComponent);
				}
			} catch {
				/* SDK 解析失败不影响 chunk 路径 */
			}
			if (classes.length === 0) {
				discoverState = "未找到运行时类（接管不生效）";
				return;
			}
			let applied = 0;
			for (const ctor of classes) {
				if (patchClass(ctor)) applied += 1;
			}
			patched = applied;
			discoverState = `候选 ${classes.length} 个，已补丁 ${applied} 个（v${PATCH_VERSION}）`;
		} catch (err) {
			discoverState = `发现失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	};

	const readToggleKey = async (): Promise<void> => {
		try {
			const sdk = (await import("@earendil-works/pi-coding-agent")) as {
				keyText?: (binding: string) => string;
			};
			const key = sdk.keyText?.("app.thinking.toggle");
			if (typeof key === "string" && key.trim()) toggleKey = key;
		} catch {
			/* 拿不到就用默认 Ctrl+T */
		}
	};

	// 原型补丁与会话无关，启动即装；失败则在会话起点再试一次
	void readToggleKey().then(() => install());
	if (typeof pi.appendEntry === "function") {
		appendTiming = (ts, ms) => {
			try {
				pi.appendEntry?.(TIMING_ENTRY_TYPE, { ts, ms });
			} catch {
				/* 会话已关闭或不可写：时长退化为本次进程内有效 */
			}
		};
	}
	pi.on("message_end", (...args: unknown[]) => {
		const event = args[0] as { message?: AssistantMessage } | undefined;
		const message = event?.message;
		if (message?.role === "assistant") persistTiming(message);
	});
	pi.on("session_start", (...args: unknown[]) => {
		timings.clear();
		persistedTimings.clear();
		const ctx = args[1] as CommandContext | undefined;
		sessionEntries = ctx?.sessionManager;
		timingsRestored = false;
		// 条目可能晚于事件就绪：拿不到就等第一次渲染时按需恢复
		ensureTimingsRestored();
		forgetTurnFolds();
		// 进程内换会话（/resume、会话选择器、fork）时 pi 先渲染历史再绑定扩展：
		// 那些行已经按「无计时」定稿，恢复之后必须重绘一遍，否则会停在 Thought (N runs)。
		if (liveComponents.size > 0) queueMicrotask(() => refreshAllComponents());
		void install();
	});
	pi.on("session_shutdown", () => {
		timings.clear();
		persistedTimings.clear();
		timingsRestored = false;
		liveComponents.clear();
		sessionEntries = undefined;
		forgetTurnFolds();
	});

	const adoptContext = (ctx: CommandContext): void => {
		if (ctx?.sessionManager?.getEntries) sessionEntries = ctx.sessionManager;
	};

	const switchMode = (next: Mode, ctx: CommandContext): void => {
		mode = next;
		saveMode(mode);
		adoptContext(ctx);
		refreshAllComponents();
		ctx.ui?.notify?.(`thinking-digest 已切换到 ${mode}`, "info");
	};

	const cycleMode = (): Mode => {
		const index = MODES.indexOf(mode);
		return MODES[(index + 1) % MODES.length] ?? "digest";
	};

	pi.registerShortcut("ctrl+shift+k", {
		description: "循环 thinking-digest 模式：hide → digest → latest",
		handler: (ctx) => switchMode(cycleMode(), ctx),
	});

	pi.registerCommand("td-mode", {
		description: "切换思考行显示模式：hide（全隐藏）| digest（每段一行摘要）| latest（每轮折叠成一行）",
		handler: (args, ctx) => {
			const raw = String(args ?? "").trim().toLowerCase();
			if (!raw) {
				ctx.ui?.notify?.(`thinking-digest 当前模式：${mode}（用法：/td-mode hide|digest|latest）`, "info");
				return;
			}
			if (!MODES.includes(raw as Mode)) {
				ctx.ui?.notify?.(`未知模式「${raw}」，可选：hide | digest | latest`, "warning");
				return;
			}
			switchMode(raw as Mode, ctx);
		},
	});

	pi.registerCommand("td-status", {
		description: "报告 thinking-digest 的接管状态、当前模式与最近一条摘要",
		handler: (_args, ctx) => {
			adoptContext(ctx);
			ctx.ui?.notify?.(
				`thinking-digest：模式 ${mode}；${patched > 0 ? "已接管" : "未接管"}（${discoverState}）；` +
					`实例 ${INSTANCE_ID}；托管组件 ${liveComponents.size} 个，计时 ${timings.size} 条，updateContent 调用 ${patchCalls} 次，原型 ${patchedProtoName}，最近摘要：${lastDigest || "无"}`,
				patched > 0 ? "info" : "warning",
			);
		},
	});
}

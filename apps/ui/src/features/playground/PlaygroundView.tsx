import { useMemo, useRef, useState } from "hono/jsx/dom";
import {
	Button,
	Input,
	SingleSelect,
	Switch,
} from "../../components/ui";
import { apiBase } from "../../core/constants";
import type {
	CanonicalModelItem,
	ModelItem,
	Site,
} from "../../core/types";

type PlaygroundViewProps = {
	sites: Site[];
	token: string | null;
	models: ModelItem[];
	canonicalModels: CanonicalModelItem[];
};

type ChatRole = "system" | "user" | "assistant";

function extractStreamText(partial: unknown): string {
	const o = (partial ?? {}) as Record<string, any>;
	// OpenAI 兼容：choices[0].delta.content
	const delta = o?.choices?.[0]?.delta?.content;
	if (typeof delta === "string" && delta.length > 0) return delta;
	// Anthropic：event=content_block_delta 时 delta.text
	if (typeof o?.delta?.text === "string" && o.delta.text.length > 0) {
		return o.delta.text;
	}
	// Gemini：candidates[0].content.parts[].text
	const parts = o?.candidates?.[0]?.content?.parts;
	if (Array.isArray(parts)) {
		const t = parts.map((p: any) => p?.text ?? "").join("");
		if (t) return t;
	}
	return "";
}

export const PlaygroundView = ({
	sites,
	token,
	models,
	canonicalModels,
}: PlaygroundViewProps) => {
	const [channelId, setChannelId] = useState("");
	const [model, setModel] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [userMessage, setUserMessage] = useState("");
	const [temperature, setTemperature] = useState("");
	const [maxTokens, setMaxTokens] = useState("");
	const [stream, setStream] = useState(false);

	const [output, setOutput] = useState("");
	const [statusLine, setStatusLine] = useState<string>(
		"选择一个渠道与模型，发送一条消息即可验证该 Key / 供应商是否可用。",
	);
	const [sending, setSending] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	// 渠道选项
	const channelOptions = useMemo(
		() =>
			sites.map((s) => ({
				value: s.id,
				label: `${s.name}（${s.site_type}）`,
				description: s.base_url || undefined,
			})),
		[sites],
	);

	// 模型建议：优先展示所选渠道实际拥有的模型，否则展示全部已发现模型
	const modelSuggestions = useMemo(() => {
		const set = new Set<string>();
		if (channelId) {
			for (const m of models) {
				if (m.channels?.some((c) => c.id === channelId)) set.add(m.id);
			}
		}
		if (set.size === 0) {
			for (const m of models) set.add(m.id);
		}
		for (const cm of canonicalModels) set.add(cm.canonical_model);
		return Array.from(set).sort();
	}, [channelId, models, canonicalModels]);

	const selectedSite = useMemo(
		() => sites.find((s) => s.id === channelId) ?? null,
		[sites, channelId],
	);

	const canSend =
		!sending && Boolean(channelId) && Boolean(model) && userMessage.trim().length > 0;

	const stopSending = () => {
		abortRef.current?.abort();
		abortRef.current = null;
		setSending(false);
		setStatusLine("已取消。");
	};

	const handleSend = async () => {
		if (!canSend) return;
		setSending(true);
		setOutput("");
		setStatusLine("请求中…");

		const messages: { role: ChatRole; content: string }[] = [];
		if (systemPrompt.trim()) {
			messages.push({ role: "system", content: systemPrompt.trim() });
		}
		messages.push({ role: "user", content: userMessage.trim() });

		const body: Record<string, unknown> = {
			channel_id: channelId,
			model,
			messages,
			stream,
		};
		if (temperature.trim() !== "" && !Number.isNaN(Number(temperature))) {
			body.temperature = Number(temperature);
		}
		if (maxTokens.trim() !== "" && !Number.isNaN(Number(maxTokens))) {
			body.max_tokens = Number(maxTokens);
		}

		const controller = new AbortController();
		abortRef.current = controller;

		try {
			const res = await fetch(`${apiBase}/api/playground/chat`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (stream) {
				// 流式：原样透传上游 SSE，前端增量解析文本
				if (!res.ok || !res.body) {
					const text = await res.text().catch(() => "");
					setOutput(text.slice(0, 2000) || `HTTP ${res.status}`);
					setStatusLine(`失败：HTTP ${res.status}`);
					setSending(false);
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let acc = "";
				let startedAt = Date.now();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data:")) continue;
						const data = trimmed.slice(5).trim();
						if (data === "[DONE]") continue;
						try {
							const inc = extractStreamText(JSON.parse(data));
							if (inc) {
								acc += inc;
								setOutput(acc);
							}
						} catch {
							// 非 JSON 的 SSE 行忽略
						}
					}
				}
				setStatusLine(
					`流式完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
				);
				setSending(false);
				return;
			}

			// 非流式：解析 JSON
			const json = (await res.json().catch(() => null)) as Record<string, any> | null;
			if (!res.ok) {
				setOutput(JSON.stringify(json ?? null, null, 2).slice(0, 4000));
				setStatusLine(`失败：HTTP ${res.status}`);
				setSending(false);
				return;
			}
			if (json?.ok) {
				setOutput(String(json.content ?? ""));
				const truncated =
					typeof json.raw === "string" && json.raw.length > String(json.content ?? "").length;
				setStatusLine(
					`成功（HTTP ${json.status ?? res.status}）` +
						(truncated ? "；下方为原始响应。" : ""),
				);
				if (truncated) {
					setOutput(`${json.content}\n\n--- 原始响应 ---\n${json.raw}`);
				}
			} else {
				setOutput(JSON.stringify(json ?? null, null, 2).slice(0, 4000));
				setStatusLine(`失败：${json?.error ?? `HTTP ${res.status}`}`);
			}
		} catch (err) {
			setOutput(String((err as Error)?.message ?? err));
			setStatusLine("请求异常（可能已取消或网络错误）。");
		} finally {
			abortRef.current = null;
			setSending(false);
		}
	};

	return (
		<div class="app-card p-5 animate-fade-up">
			<div class="mb-4">
				<h2 class="text-lg font-semibold text-[color:var(--app-ink)]">游乐场</h2>
				<p class="mt-1 text-sm text-[color:var(--app-ink-muted)]">
					在管理台内直接选渠道 + 模型发一条消息，验证某把 Key / 供应商是否真的可用
					（参考 new-api 的 Playground）。请求走管理台鉴权，不会暴露你的调用口令。
				</p>
			</div>

			<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{/* 左列：参数 */}
				<div class="space-y-4">
					<div>
						<label class="mb-1.5 block text-sm font-medium text-[color:var(--app-ink)]">
							渠道（站点）
						</label>
						<SingleSelect
							options={channelOptions}
							value={channelId}
							onChange={setChannelId}
							placeholder="请选择渠道"
							disabled={sites.length === 0}
						/>
						{sites.length === 0 ? (
							<p class="mt-1 text-xs text-[color:var(--app-ink-muted)]">
								暂无站点，请先在「站点管理」中创建渠道。
							</p>
						) : null}
						{selectedSite ? (
							<p class="mt-1 text-xs text-[color:var(--app-ink-muted)]">
								类型：{selectedSite.site_type} · 端点：
								{selectedSite.base_url || "（未配置）"}
							</p>
						) : null}
					</div>

					<div>
						<label class="mb-1.5 block text-sm font-medium text-[color:var(--app-ink)]">
							模型
						</label>
						<Input
							value={model}
							onInput={(e) => setModel((e.target as HTMLInputElement).value)}
							placeholder="例如 gemini-1.5-flash / gpt-4o / claude-3-5-sonnet"
							list="playground-model-suggestions"
						/>
						<datalist id="playground-model-suggestions">
							{modelSuggestions.map((m) => (
								<option value={m} />
							))}
						</datalist>
					</div>

					<div>
						<label class="mb-1.5 block text-sm font-medium text-[color:var(--app-ink)]">
							系统提示词（可选）
						</label>
						<textarea
							class="app-input"
							style="min-height:80px; resize:vertical;"
							value={systemPrompt}
							onInput={(e) => setSystemPrompt((e.target as HTMLTextAreaElement).value)}
							placeholder="留空则不携带 system 消息"
						/>
					</div>

					<div>
						<label class="mb-1.5 block text-sm font-medium text-[color:var(--app-ink)]">
							用户消息
						</label>
						<textarea
							class="app-input"
							style="min-height:120px; resize:vertical;"
							value={userMessage}
							onInput={(e) => setUserMessage((e.target as HTMLTextAreaElement).value)}
							placeholder="输入要发送给模型的内容…"
						/>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="mb-1.5 block text-sm font-medium text-[color:var(--app-ink)]">
								温度（可选）
							</label>
							<Input
								type="number"
								step="0.1"
								min="0"
								max="2"
								value={temperature}
								onInput={(e) =>
									setTemperature((e.target as HTMLInputElement).value)
								}
								placeholder="默认不传"
							/>
						</div>
						<div>
							<label class="mb-1.5 block text-sm font-medium text-[color:var(--app-ink)]">
								最大 Token（可选）
							</label>
							<Input
								type="number"
								min="1"
								value={maxTokens}
								onInput={(e) =>
									setMaxTokens((e.target as HTMLInputElement).value)
								}
								placeholder="默认不传"
							/>
						</div>
					</div>

					<div class="flex items-center justify-between rounded-lg border border-[color:var(--app-border)] bg-white/60 px-3 py-2.5">
						<div>
							<div class="text-sm font-medium text-[color:var(--app-ink)]">
								流式输出（SSE）
							</div>
							<div class="text-xs text-[color:var(--app-ink-muted)]">
								开启后实时显示增量回复
							</div>
						</div>
						<Switch checked={stream} onToggle={setStream} />
					</div>

					<div class="flex items-center gap-3">
						{!sending ? (
							<Button
								variant="primary"
								disabled={!canSend}
								onClick={handleSend}
							>
								发送
							</Button>
						) : (
							<Button variant="danger" onClick={stopSending}>
								停止
							</Button>
						)}
						<span class="text-xs text-[color:var(--app-ink-muted)]">
							{!channelId || !model || userMessage.trim().length === 0
								? "请填写渠道、模型与用户消息"
								: "就绪"}
						</span>
					</div>
				</div>

				{/* 右列：结果 */}
				<div class="flex flex-col">
					<div class="mb-2 flex items-center justify-between">
						<label class="text-sm font-medium text-[color:var(--app-ink)]">
							回复
						</label>
						<span class="text-xs text-[color:var(--app-ink-muted)]">
							{statusLine}
						</span>
					</div>
					<div class="min-h-[320px] flex-1 whitespace-pre-wrap rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-panel)] p-4 text-sm leading-relaxed text-[color:var(--app-ink)]">
						{output || (
							<span class="text-[color:var(--app-ink-muted)]">
								发送后这里会显示模型回复 / 错误信息。
							</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};

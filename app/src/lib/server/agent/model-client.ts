import { env } from '$env/dynamic/private';

export interface ModelMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ModelConfiguration {
	url: string;
	apiKey: string;
	model: string;
	isZhihu: boolean;
	protocol?: 'opencode';
	username?: string;
}

export interface ModelCallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ModelClient {
	complete(messages: ModelMessage[], options?: ModelCallOptions): Promise<string>;
}

// 真实推理（尤其 OpenCode 协议）常常超过半分钟，过激的超时会把正常运行判成失败。
export const DEFAULT_MODEL_TIMEOUT_MS = 90_000;
const SESSION_CLEANUP_TIMEOUT_MS = 5_000;

export type ModelFailureReason = 'timeout' | 'network' | 'http' | 'payload' | 'cancelled';

export class ModelConfigurationError extends Error {
	constructor() {
		super('尚未配置可用的 Agent 模型');
		this.name = 'ModelConfigurationError';
	}
}

export class ModelClientError extends Error {
	readonly reason: ModelFailureReason;
	readonly retryable: boolean;
	readonly status: number | null;

	constructor(
		message: string,
		options: { reason?: ModelFailureReason; status?: number | null } = {}
	) {
		super(message);
		this.name = 'ModelClientError';
		this.reason = options.reason ?? 'payload';
		this.status = options.status ?? null;
		this.retryable = isRetryable(this.reason, this.status);
	}
}

function isRetryable(reason: ModelFailureReason, status: number | null): boolean {
	if (reason === 'timeout' || reason === 'network') return true;
	if (reason === 'http') return status === 429 || (status !== null && status >= 500);
	return false;
}

export function resolveModelTimeoutMs(values: Record<string, string | undefined>): number {
	const parsed = Number(values.GUIDANCE_MODEL_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MODEL_TIMEOUT_MS;
}

/**
 * A caller-supplied signal must win over our own deadline so the runtime can attribute
 * the failure to cancellation rather than to a timeout it did not hit.
 */
function callSignal(options: ModelCallOptions | undefined, fallbackTimeoutMs: number): AbortSignal {
	const timeoutMs = options?.timeoutMs ?? fallbackTimeoutMs;
	const deadline = AbortSignal.timeout(timeoutMs);
	return options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
}

function abortError(options: ModelCallOptions | undefined): ModelClientError {
	if (options?.signal?.aborted) {
		return new ModelClientError('本轮指导请求已取消', { reason: 'cancelled' });
	}
	return new ModelClientError('Agent 模型响应超时', { reason: 'timeout' });
}

export function resolveModelConfiguration(
	values: Record<string, string | undefined>
): ModelConfiguration | null {
	if (values.AGENT_API_URL && values.AGENT_MODEL) {
		return {
			url: values.AGENT_API_URL,
			apiKey: values.AGENT_API_KEY ?? '',
			model: values.AGENT_MODEL,
			isZhihu: values.AGENT_API_URL.includes('developer.zhihu.com')
		};
	}
	if (values.OPENCODE_SERVER_URL && values.OPENCODE_SERVER_PASSWORD) {
		return {
			url: values.OPENCODE_SERVER_URL,
			apiKey: values.OPENCODE_SERVER_PASSWORD,
			model: 'server-default',
			isZhihu: false,
			protocol: 'opencode',
			username: values.OPENCODE_SERVER_USERNAME || 'opencode'
		};
	}
	if (values.ZHIHU_ACCESS_SECRET) {
		return {
			url: 'https://developer.zhihu.com/v1/chat/completions',
			apiKey: values.ZHIHU_ACCESS_SECRET,
			model: 'zhida-agent',
			isZhihu: true
		};
	}
	return null;
}

export function createModelClient(
	configuration: ModelConfiguration,
	options: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {}
): ModelClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
	if (configuration.protocol === 'opencode') {
		return createOpenCodeModelClient(configuration, fetchImpl, defaultTimeoutMs);
	}

	return {
		async complete(messages, callOptions) {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (configuration.apiKey) headers.Authorization = `Bearer ${configuration.apiKey}`;
			if (configuration.isZhihu) {
				headers['X-Request-Timestamp'] = String(Math.floor(now() / 1_000));
			}
			let response: Response;
			try {
				response = await fetchImpl(configuration.url, {
					method: 'POST',
					headers,
					body: JSON.stringify({ model: configuration.model, messages, stream: false }),
					signal: callSignal(callOptions, defaultTimeoutMs)
				});
			} catch (error) {
				if (isAbort(error)) throw abortError(callOptions);
				throw new ModelClientError('Agent 模型暂时无法连接', { reason: 'network' });
			}
			if (!response.ok) {
				throw new ModelClientError(`Agent 模型请求失败（HTTP ${response.status}）`, {
					reason: 'http',
					status: response.status
				});
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch (error) {
				if (isAbort(error)) throw abortError(callOptions);
				throw new ModelClientError('Agent 模型返回了无法解析的数据', { reason: 'payload' });
			}
			const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
				.choices?.[0]?.message?.content;
			if (typeof content !== 'string' || !content.trim()) {
				throw new ModelClientError('Agent 模型没有返回可用动作', { reason: 'payload' });
			}
			return content;
		}
	};
}

function isAbort(error: unknown): boolean {
	return (
		error instanceof DOMException ||
		(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
	);
}

function createOpenCodeModelClient(
	configuration: ModelConfiguration,
	fetchImpl: typeof fetch,
	defaultTimeoutMs: number
): ModelClient {
	const origin = configuration.url.replace(/\/$/, '');
	const authorization = `Basic ${Buffer.from(`${configuration.username ?? 'opencode'}:${configuration.apiKey}`).toString('base64')}`;
	const headers = { Authorization: authorization, 'Content-Type': 'application/json' };

	async function request(
		path: string,
		init: RequestInit,
		callOptions: ModelCallOptions | undefined,
		signal: AbortSignal
	): Promise<Response> {
		let response: Response;
		try {
			response = await fetchImpl(`${origin}${path}`, { ...init, headers, signal });
		} catch (error) {
			if (isAbort(error)) throw abortError(callOptions);
			throw new ModelClientError('通用 Agent 服务暂时无法连接', { reason: 'network' });
		}
		if (!response.ok) {
			throw new ModelClientError(`通用 Agent 服务请求失败（HTTP ${response.status}）`, {
				reason: 'http',
				status: response.status
			});
		}
		return response;
	}

	return {
		async complete(messages, callOptions) {
			const signal = callSignal(callOptions, defaultTimeoutMs);
			const sessionResponse = await request(
				'/session',
				{ method: 'POST', body: JSON.stringify({ title: 'Background Board decision turn' }) },
				callOptions,
				signal
			);
			const session = (await sessionResponse.json()) as { id?: unknown };
			if (typeof session.id !== 'string') {
				throw new ModelClientError('通用 Agent 服务未创建会话', { reason: 'payload' });
			}
			try {
				const system = messages.find((message) => message.role === 'system')?.content ?? '';
				const conversation = messages
					.filter((message) => message.role !== 'system')
					.map((message) => `${message.role}: ${message.content}`)
					.join('\n\n');
				const response = await request(
					`/session/${session.id}/message`,
					{
						method: 'POST',
						body: JSON.stringify({
							system,
							tools: {
								bash: false,
								edit: false,
								write: false,
								read: false,
								glob: false,
								grep: false,
								webfetch: false,
								websearch: false,
								task: false,
								skill: false,
								todowrite: false,
								todoread: false
							},
							parts: [{ type: 'text', text: conversation }]
						})
					},
					callOptions,
					signal
				);
				const payload = (await response.json()) as {
					parts?: Array<{ type?: unknown; text?: unknown }>;
				};
				const content = payload.parts?.find(
					(part) => part.type === 'text' && typeof part.text === 'string'
				)?.text;
				if (typeof content !== 'string' || !content.trim()) {
					throw new ModelClientError('通用 Agent 服务没有返回可用动作', { reason: 'payload' });
				}
				return content;
			} finally {
				// Cleanup runs on its own deadline: a cancelled parent call must still release the
				// session, and a failed release must never rewrite the original failure reason.
				try {
					await fetchImpl(`${origin}/session/${session.id}`, {
						method: 'DELETE',
						headers,
						signal: AbortSignal.timeout(SESSION_CLEANUP_TIMEOUT_MS)
					});
				} catch {
					// A leaked short-lived inference session must not mask a valid model response.
				}
			}
		}
	};
}

export function createConfiguredModelClient(): ModelClient {
	const configuration = resolveModelConfiguration(env);
	if (!configuration) throw new ModelConfigurationError();
	return createModelClient(configuration, { timeoutMs: resolveModelTimeoutMs(env) });
}

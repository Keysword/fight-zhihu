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

export interface ModelClient {
	complete(messages: ModelMessage[]): Promise<string>;
}

export class ModelConfigurationError extends Error {
	constructor() {
		super('尚未配置可用的 Agent 模型');
		this.name = 'ModelConfigurationError';
	}
}

export class ModelClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelClientError';
	}
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
	options: { fetchImpl?: typeof fetch; now?: () => number } = {}
): ModelClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	if (configuration.protocol === 'opencode') {
		return createOpenCodeModelClient(configuration, fetchImpl);
	}

	return {
		async complete(messages) {
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
					body: JSON.stringify({ model: configuration.model, messages, stream: false })
				});
			} catch {
				throw new ModelClientError('Agent 模型暂时无法连接');
			}
			if (!response.ok) throw new ModelClientError(`Agent 模型请求失败（HTTP ${response.status}）`);
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ModelClientError('Agent 模型返回了无法解析的数据');
			}
			const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
				.choices?.[0]?.message?.content;
			if (typeof content !== 'string' || !content.trim()) {
				throw new ModelClientError('Agent 模型没有返回可用动作');
			}
			return content;
		}
	};
}

function createOpenCodeModelClient(
	configuration: ModelConfiguration,
	fetchImpl: typeof fetch
): ModelClient {
	const origin = configuration.url.replace(/\/$/, '');
	const authorization = `Basic ${Buffer.from(`${configuration.username ?? 'opencode'}:${configuration.apiKey}`).toString('base64')}`;
	const headers = { Authorization: authorization, 'Content-Type': 'application/json' };

	async function request(path: string, init: RequestInit): Promise<Response> {
		let response: Response;
		try {
			response = await fetchImpl(`${origin}${path}`, { ...init, headers });
		} catch {
			throw new ModelClientError('通用 Agent 服务暂时无法连接');
		}
		if (!response.ok)
			throw new ModelClientError(`通用 Agent 服务请求失败（HTTP ${response.status}）`);
		return response;
	}

	return {
		async complete(messages) {
			const sessionResponse = await request('/session', {
				method: 'POST',
				body: JSON.stringify({ title: 'Background Board decision turn' })
			});
			const session = (await sessionResponse.json()) as { id?: unknown };
			if (typeof session.id !== 'string') throw new ModelClientError('通用 Agent 服务未创建会话');
			try {
				const system = messages.find((message) => message.role === 'system')?.content ?? '';
				const conversation = messages
					.filter((message) => message.role !== 'system')
					.map((message) => `${message.role}: ${message.content}`)
					.join('\n\n');
				const response = await request(`/session/${session.id}/message`, {
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
				});
				const payload = (await response.json()) as {
					parts?: Array<{ type?: unknown; text?: unknown }>;
				};
				const content = payload.parts?.find(
					(part) => part.type === 'text' && typeof part.text === 'string'
				)?.text;
				if (typeof content !== 'string' || !content.trim()) {
					throw new ModelClientError('通用 Agent 服务没有返回可用动作');
				}
				return content;
			} finally {
				try {
					await request(`/session/${session.id}`, { method: 'DELETE' });
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
	return createModelClient(configuration);
}

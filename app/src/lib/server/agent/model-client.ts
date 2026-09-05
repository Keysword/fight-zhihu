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
			const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
				?.message?.content;
			if (typeof content !== 'string' || !content.trim()) {
				throw new ModelClientError('Agent 模型没有返回可用动作');
			}
			return content;
		}
	};
}

export function createConfiguredModelClient(): ModelClient {
	const configuration = resolveModelConfiguration(env);
	if (!configuration) throw new ModelConfigurationError();
	return createModelClient(configuration);
}

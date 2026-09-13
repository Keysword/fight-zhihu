import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

import {
	ModelClientError,
	type ModelCallOptions,
	type ModelClient,
	type ModelMessage,
	type ModelObservation
} from './model-client';

export const DEFAULT_SDK_MODEL_TIMEOUT_MS = 40_000;

export interface SdkConfiguration {
	baseURL: string;
	apiKey: string;
	model: string;
	stream: boolean;
}

export interface SdkModelClientOptions {
	fetchImpl?: typeof fetch;
	now?: () => number;
}

interface ObservedUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
}

function readUsage(usage: unknown): ObservedUsage {
	if (typeof usage !== 'object' || usage === null) {
		return { inputTokens: null, outputTokens: null, reasoningTokens: null };
	}
	const source = usage as {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		completion_tokens_details?: { reasoning_tokens?: unknown };
	};
	const integerOrNull = (value: unknown): number | null =>
		typeof value === 'number' && Number.isFinite(value) ? value : null;
	return {
		inputTokens: integerOrNull(source.prompt_tokens),
		outputTokens: integerOrNull(source.completion_tokens),
		reasoningTokens: integerOrNull(source.completion_tokens_details?.reasoning_tokens)
	};
}

/**
 * OpenAI 兼容端点的 SDK 直连适配器。
 * SDK 默认带自动重试与长超时；这里显式关闭重试、按调用传入超时，
 * 重试与总预算由 guidance-runtime 统一负责。
 */
export function createSdkModelClient(
	configuration: SdkConfiguration,
	options: SdkModelClientOptions = {}
): ModelClient {
	const now = options.now ?? Date.now;
	const sdk = new OpenAI({
		baseURL: configuration.baseURL,
		apiKey: configuration.apiKey,
		maxRetries: 0,
		timeout: DEFAULT_SDK_MODEL_TIMEOUT_MS,
		fetch: options.fetchImpl
	});

	return {
		async complete(messages: ModelMessage[], callOptions?: ModelCallOptions): Promise<string> {
			const timeoutMs = callOptions?.timeoutMs ?? DEFAULT_SDK_MODEL_TIMEOUT_MS;
			const startedAt = now();
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = callOptions?.signal
				? AbortSignal.any([callOptions.signal, deadline])
				: deadline;
			const inputCharacters = messages.reduce((total, message) => total + message.content.length, 0);
			let firstContentMs: number | null = null;
			let outputCharacters = 0;
			let finishReason: string | null = null;
			let usage: ObservedUsage = { inputTokens: null, outputTokens: null, reasoningTokens: null };

			const emitObservation = (failure: ModelClientError | null): void => {
				if (!callOptions?.onObservation) return;
				const observation: ModelObservation = {
					transport: 'sdk',
					durationMs: Math.round(now() - startedAt),
					firstContentMs,
					inputCharacters,
					outputCharacters,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					reasoningTokens: usage.reasoningTokens,
					finishReason
				};
				try {
					callOptions.onObservation(observation);
				} catch {
					// 观测回调异常不得让已成功（或已失败）的请求改写结果。
				}
			};

			try {
				if (configuration.stream) {
					const stream = await sdk.chat.completions.create(
						{ model: configuration.model, messages, stream: true },
						{ signal, timeout: timeoutMs, maxRetries: 0 }
					);
					let content = '';
					for await (const chunk of stream) {
						if (typeof chunk.usage !== 'undefined') usage = readUsage(chunk.usage);
						const choice = chunk.choices?.[0];
						const delta = choice?.delta?.content;
						if (typeof delta === 'string' && delta.length > 0) {
							if (firstContentMs === null) firstContentMs = Math.round(now() - startedAt);
							content += delta;
							outputCharacters = content.length;
						}
						if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
					}
					// 正常结束的流最后必带 finish_reason；流中断时看不到它，按 payload 失败处理。
					if (finishReason === null) {
						throw new ModelClientError('模型流在没有结束标记的情况下中断', { reason: 'payload' });
					}
					if (finishReason === 'length') {
						throw new ModelClientError('模型回复因长度上限被截断，不能作为完整指导', {
							reason: 'payload'
						});
					}
					if (!content.trim()) {
						throw new ModelClientError('模型流没有返回可用正文', { reason: 'payload' });
					}
					emitObservation(null);
					return content;
				}

				const response = await sdk.chat.completions.create(
					{ model: configuration.model, messages, stream: false },
					{ signal, timeout: timeoutMs, maxRetries: 0 }
				);
				usage = readUsage(response.usage);
				const choice = response.choices?.[0];
				if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
				const content = choice?.message?.content;
				if (finishReason === 'length') {
					throw new ModelClientError('模型回复因长度上限被截断，不能作为完整指导', {
						reason: 'payload'
					});
				}
				if (typeof content !== 'string' || !content.trim()) {
					throw new ModelClientError('模型没有返回可用正文', { reason: 'payload' });
				}
				outputCharacters = content.length;
				emitObservation(null);
				return content;
			} catch (error) {
				const mapped = mapSdkError(error, callOptions, deadline);
				emitObservation(mapped);
				throw mapped;
			}
		}
	};
}

function mapSdkError(
	error: unknown,
	callOptions: ModelCallOptions | undefined,
	deadline: AbortSignal
): ModelClientError {
	if (error instanceof ModelClientError) return error;
	// 上级取消优先于自身超时：调用方放弃的请求必须归因到取消。
	if (callOptions?.signal?.aborted) {
		return new ModelClientError('本轮指导请求已取消', { reason: 'cancelled' });
	}
	// 只有自身截止时间真正触发时才归为 timeout；不把所有 DOMException 一概当超时。
	if (deadline.aborted || error instanceof APIConnectionTimeoutError) {
		return new ModelClientError('Agent 模型响应超时', { reason: 'timeout' });
	}
	if (error instanceof APIUserAbortError) {
		return new ModelClientError('本轮指导请求已取消', { reason: 'cancelled' });
	}
	if (error instanceof APIConnectionError) {
		return new ModelClientError('Agent 模型暂时无法连接', { reason: 'network' });
	}
	if (error instanceof APIError && typeof error.status === 'number') {
		return new ModelClientError(`Agent 模型请求失败（HTTP ${error.status}）`, {
			reason: 'http',
			status: error.status
		});
	}
	return new ModelClientError('Agent 模型返回了无法解析的数据', { reason: 'payload' });
}

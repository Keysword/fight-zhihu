import { describe, expect, it, vi } from 'vitest';

import { ModelClientError } from './model-client';
import { createSdkModelClient } from './sdk-model-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init
	});
}

function completionResponse(content: string, finishReason = 'stop'): Response {
	return jsonResponse({
		id: 'chatcmpl-test',
		object: 'chat.completion',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content },
				finish_reason: finishReason
			}
		],
		usage: {
			prompt_tokens: 11,
			completion_tokens: 7,
			total_tokens: 18
		}
	});
}

function sseResponse(events: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) controller.enqueue(encoder.encode(event));
			controller.close();
		}
	});
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' }
	});
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: 'chatcmpl-stream',
		object: 'chat.completion.chunk',
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	})}\n\n`;
}

describe('sdk model client request contract', () => {
	it('uses the SDK base URL and performs no hidden retry', async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ error: { message: 'busy', type: 'server_error' } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl }
		);
		await expect(client.complete([{ role: 'user', content: 'test' }])).rejects.toMatchObject({
			reason: 'http',
			status: 503
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('posts to /chat/completions under the base URL with a Bearer header', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => completionResponse('好的'));
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl }
		);
		await client.complete([{ role: 'user', content: '你好' }]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://unit.invalid/v1/chat/completions');
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-key');
		const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
		expect(body.model).toBe('test-model');
		expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
	});

	it('returns the message content and emits one observation', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => completionResponse('已给出的建议'));
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl }
		);
		const observations: unknown[] = [];
		const content = await client.complete([{ role: 'user', content: '帮我' }], {
			onObservation: (observation) => observations.push(observation)
		});
		expect(content).toBe('已给出的建议');
		expect(observations).toHaveLength(1);
		const observation = observations[0] as {
			transport: string;
			firstContentMs: number | null;
			inputCharacters: number;
			outputCharacters: number;
			inputTokens: number | null;
			outputTokens: number | null;
			reasoningTokens: number | null;
			finishReason: string | null;
		};
		expect(observation.transport).toBe('sdk');
		expect(observation.firstContentMs).toBeNull();
		expect(observation.inputCharacters).toBe(2);
		expect(observation.outputCharacters).toBe(6);
		expect(observation.inputTokens).toBe(11);
		expect(observation.outputTokens).toBe(7);
		expect(observation.reasoningTokens).toBeNull();
		expect(observation.finishReason).toBe('stop');
	});

	it('does not retry on 401 or 429', async () => {
		for (const status of [401, 429]) {
			const fetchImpl = vi.fn<typeof fetch>(
				async () => new Response('denied', { status, headers: { 'content-type': 'text/plain' } })
			);
			const client = createSdkModelClient(
				{
					baseURL: 'https://unit.invalid/v1',
					apiKey: 'test-key',
					model: 'test-model',
					stream: false
				},
				{ fetchImpl }
			);
			await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
				reason: 'http',
				status
			});
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		}
	});

	it('classifies connection failures as network errors', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new TypeError('fetch failed: ECONNREFUSED');
		});
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl }
		);
		await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
			reason: 'network'
		});
	});

	it('maps a caller cancel to cancelled and a self deadline to timeout', async () => {
		const hangingFetch = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl: hangingFetch }
		);
		const caller = new AbortController();
		const cancelled = client.complete([{ role: 'user', content: 'x' }], { signal: caller.signal });
		const assertionCancelled = expect(cancelled).rejects.toMatchObject({ reason: 'cancelled' });
		caller.abort();
		await assertionCancelled;

		const deadline = client.complete([{ role: 'user', content: 'x' }], { timeoutMs: 30 });
		await expect(deadline).rejects.toMatchObject({ reason: 'timeout' });
	});

	it('classifies a timeout while reading the body as timeout', async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise<Response>((resolve) => {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"id":"x"'));
							init?.signal?.addEventListener('abort', () => {
								controller.error(new DOMException('aborted', 'TimeoutError'));
							});
						}
					});
					resolve(
						new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
					);
				})
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl }
		);
		await expect(
			client.complete([{ role: 'user', content: 'x' }], { timeoutMs: 40 })
		).rejects.toMatchObject({ reason: 'timeout' });
	});

	it('treats empty or blank content as a payload failure', async () => {
		for (const content of [null, '', '   ']) {
			const fetchImpl = vi.fn<typeof fetch>(async () => completionResponse(content as string));
			const client = createSdkModelClient(
				{
					baseURL: 'https://unit.invalid/v1',
					apiKey: 'test-key',
					model: 'test-model',
					stream: false
				},
				{ fetchImpl }
			);
			await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
				ModelClientError
			);
			await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
				reason: 'payload'
			});
		}
	});

	it('does not hand a length-truncated completion to the save phase', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			completionResponse('{"type":"provide_guid', 'length')
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl }
		);
		await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
			reason: 'payload'
		});
	});
});

describe('sdk model client streaming', () => {
	it('assembles stream content and records first non-empty content time', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			sseResponse([
				chunk({ role: 'assistant', content: '' }),
				chunk({ content: '第一' }),
				chunk({ content: '步建议' }),
				chunk({}, 'stop'),
				'data: [DONE]\n\n'
			])
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: true
			},
			{ fetchImpl }
		);
		const observations: unknown[] = [];
		const content = await client.complete([{ role: 'user', content: '你好' }], {
			onObservation: (observation) => observations.push(observation)
		});
		expect(content).toBe('第一步建议');
		const observation = observations[0] as {
			firstContentMs: number | null;
			finishReason: string | null;
			outputCharacters: number;
		};
		expect(observation.firstContentMs).not.toBeNull();
		expect(observation.finishReason).toBe('stop');
		expect(observation.outputCharacters).toBe(5);
	});

	it('does not count empty deltas as first content', async () => {
		let ticks = 0;
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			sseResponse([
				chunk({ role: 'assistant', content: '' }),
				chunk({ content: '' }),
				chunk({ content: '正' }),
				chunk({}, 'stop')
			])
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: true
			},
			{ fetchImpl, now: () => ++ticks * 100 }
		);
		const observations: unknown[] = [];
		await client.complete([{ role: 'user', content: 'x' }], {
			onObservation: (observation) => observations.push(observation)
		});
		const observation = observations[0] as { firstContentMs: number | null };
		expect(observation.firstContentMs).toBe(100);
	});

	it('fails with a payload error when the stream is interrupted', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			sseResponse([
				chunk({ content: '写到一半' })
				// 没有 finish_reason 也没有 [DONE]，流被截断。
			])
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: true
			},
			{ fetchImpl }
		);
		await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
			reason: 'payload'
		});
	});

	it('fails on a length finish reason in a stream', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			sseResponse([chunk({ content: '半' }), chunk({}, 'length'), 'data: [DONE]\n\n'])
		);
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: true
			},
			{ fetchImpl }
		);
		await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
			reason: 'payload'
		});
	});

	it('records an observation for a failed stream attempt', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new TypeError('fetch failed');
		});
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: true
			},
			{ fetchImpl }
		);
		const observations: unknown[] = [];
		await expect(
			client.complete([{ role: 'user', content: 'hello' }], {
				onObservation: (observation) => observations.push(observation)
			})
		).rejects.toMatchObject({ reason: 'network' });
		expect(observations).toHaveLength(1);
		const observation = observations[0] as {
			transport: string;
			durationMs: number;
			outputCharacters: number;
		};
		expect(observation.transport).toBe('sdk');
		expect(observation.durationMs).toBeGreaterThanOrEqual(0);
		expect(observation.outputCharacters).toBe(0);
	});
});

describe('sdk model client observation safety', () => {
	it('keeps a successful result even when the observation callback throws', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => completionResponse('成功'));
		const client = createSdkModelClient(
			{
				baseURL: 'https://unit.invalid/v1',
				apiKey: 'test-key',
				model: 'test-model',
				stream: false
			},
			{ fetchImpl }
		);
		const content = await client.complete([{ role: 'user', content: 'x' }], {
			onObservation: () => {
				throw new Error('observer broken');
			}
		});
		expect(content).toBe('成功');
	});
});

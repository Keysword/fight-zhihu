import { describe, expect, it, vi } from 'vitest';

import {
	createModelClient,
	ModelClientError,
	resolveModelConfiguration,
	resolveModelTimeoutMs
} from './model-client';

function pendingUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		const fail = () => reject(new DOMException('aborted', 'AbortError'));
		if (!signal) return;
		if (signal.aborted) fail();
		else signal.addEventListener('abort', fail);
	});
}

function neverResolvingFetch(): typeof fetch {
	return vi.fn<typeof fetch>((_input, init) => pendingUntilAborted(init?.signal));
}

describe('model client', () => {
	it('prefers an existing OpenCode general-agent server over the Zhihu answer model', () => {
		expect(
			resolveModelConfiguration({
				OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
				OPENCODE_SERVER_PASSWORD: 'server-password',
				ZHIHU_ACCESS_SECRET: 'zhihu-secret'
			})
		).toEqual({
			url: 'http://127.0.0.1:4096',
			apiKey: 'server-password',
			model: 'server-default',
			isZhihu: false,
			protocol: 'opencode',
			username: 'opencode'
		});
	});

	it('falls back to Zhihu Direct Answer when only its access secret is configured', () => {
		expect(resolveModelConfiguration({ ZHIHU_ACCESS_SECRET: 'zhihu-secret' })).toEqual({
			url: 'https://developer.zhihu.com/v1/chat/completions',
			apiKey: 'zhihu-secret',
			model: 'zhida-agent',
			isZhihu: true
		});
	});

	it('sends only the portable request fields and returns assistant content', async () => {
		const fetchImpl = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [
							{ message: { role: 'assistant', content: '{"type":"finish","summary":"完成"}' } }
						]
					}),
					{ status: 200 }
				)
			)
		);
		const client = createModelClient(
			{
				url: 'https://example.com/v1/chat/completions',
				apiKey: 'key',
				model: 'agent',
				isZhihu: false
			},
			{ fetchImpl, now: () => 1_800_000_000_000 }
		);
		const messages = [{ role: 'user' as const, content: '分析这个案例' }];

		await expect(client.complete(messages)).resolves.toContain('finish');
		const [, options] = fetchImpl.mock.calls[0];
		expect(JSON.parse(String(options?.body))).toEqual({ model: 'agent', messages, stream: false });
		expect(options?.headers).toMatchObject({ Authorization: 'Bearer key' });
	});

	it('adds timestamp authentication for Zhihu and rejects empty responses', async () => {
		const fetchImpl = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
		);
		const client = createModelClient(
			{
				url: 'https://developer.zhihu.com/v1/chat/completions',
				apiKey: 'secret',
				model: 'zhida-agent',
				isZhihu: true
			},
			{ fetchImpl, now: () => 1_800_000_123_456 }
		);

		await expect(client.complete([{ role: 'user', content: 'test' }])).rejects.toBeInstanceOf(
			ModelClientError
		);
		expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
			'X-Request-Timestamp': '1800000123'
		});
	});

	it('runs a constrained turn through an OpenCode server and removes the temporary session', async () => {
		const fetchImpl = vi.fn<typeof fetch>((input, init) => {
			const url = String(input);
			if (url.endsWith('/session') && init?.method === 'POST') {
				return Promise.resolve(new Response(JSON.stringify({ id: 'session-1' }), { status: 200 }));
			}
			if (url.endsWith('/session/session-1/message')) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							parts: [
								{ type: 'reasoning', text: 'private' },
								{ type: 'text', text: '{"type":"finish","summary":"ok"}' }
							]
						}),
						{ status: 200 }
					)
				);
			}
			return Promise.resolve(new Response('true', { status: 200 }));
		});
		const client = createModelClient(
			{
				url: 'http://127.0.0.1:4096',
				apiKey: 'password',
				model: 'server-default',
				isZhihu: false,
				protocol: 'opencode',
				username: 'opencode'
			},
			{ fetchImpl }
		);

		await expect(
			client.complete([
				{ role: 'system', content: 'rules' },
				{ role: 'user', content: 'case' }
			])
		).resolves.toContain('finish');
		const messageCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/message'));
		const requestBody = JSON.parse(String(messageCall?.[1]?.body));
		expect(requestBody.system).toBe('rules');
		expect(requestBody.tools).toMatchObject({ bash: false, write: false, task: false });
		expect(
			fetchImpl.mock.calls.some(
				([url, init]) => String(url).endsWith('/session/session-1') && init?.method === 'DELETE'
			)
		).toBe(true);
	});

	it('rejects a hanging upstream as a retryable timeout within its own deadline', async () => {
		const fetchImpl = neverResolvingFetch();
		const client = createModelClient(
			{ url: 'https://example.com/v1/chat/completions', apiKey: 'key', model: 'agent', isZhihu: false },
			{ fetchImpl, timeoutMs: 40 }
		);

		const started = Date.now();
		const error = await client.complete([{ role: 'user', content: 'hang' }]).catch((cause) => cause);

		expect(error).toBeInstanceOf(ModelClientError);
		expect(error).toMatchObject({ reason: 'timeout', retryable: true });
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it('reports caller cancellation as non-retryable rather than as its own timeout', async () => {
		const fetchImpl = neverResolvingFetch();
		const client = createModelClient(
			{ url: 'https://example.com/v1/chat/completions', apiKey: 'key', model: 'agent', isZhihu: false },
			{ fetchImpl, timeoutMs: 5_000 }
		);
		const controller = new AbortController();
		const pending = client.complete([{ role: 'user', content: 'hang' }], {
			signal: controller.signal
		});
		controller.abort();

		await expect(pending).rejects.toMatchObject({ reason: 'cancelled', retryable: false });
	});

	it.each([
		[429, true],
		[503, true],
		[400, false],
		[404, false]
	])('classifies HTTP %i as retryable=%s', async (status, retryable) => {
		const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status })));
		const client = createModelClient(
			{ url: 'https://example.com/v1/chat/completions', apiKey: 'key', model: 'agent', isZhihu: false },
			{ fetchImpl }
		);

		await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
			reason: 'http',
			status,
			retryable
		});
	});

	it('treats an unusable payload as non-retryable and a dropped connection as retryable', async () => {
		const unusable = createModelClient(
			{ url: 'https://example.com/v1/chat/completions', apiKey: 'key', model: 'agent', isZhihu: false },
			{ fetchImpl: vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 }))) }
		);
		const dropped = createModelClient(
			{ url: 'https://example.com/v1/chat/completions', apiKey: 'key', model: 'agent', isZhihu: false },
			{ fetchImpl: vi.fn<typeof fetch>(() => Promise.reject(new TypeError('socket hang up'))) }
		);

		await expect(unusable.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
			reason: 'payload',
			retryable: false
		});
		await expect(dropped.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
			reason: 'network',
			retryable: true
		});
	});

	it('still releases the OpenCode session when the parent call is cancelled, keeping the original reason', async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>((input, init) => {
			const url = String(input);
			if (url.endsWith('/session') && init?.method === 'POST') {
				return Promise.resolve(new Response(JSON.stringify({ id: 'session-9' }), { status: 200 }));
			}
			if (url.endsWith('/message')) {
				controller.abort();
				return pendingUntilAborted(init?.signal);
			}
			return Promise.resolve(new Response('true', { status: 500 }));
		});
		const client = createModelClient(
			{
				url: 'http://127.0.0.1:4096',
				apiKey: 'password',
				model: 'server-default',
				isZhihu: false,
				protocol: 'opencode',
				username: 'opencode'
			},
			{ fetchImpl }
		);

		await expect(
			client.complete([{ role: 'user', content: 'case' }], { signal: controller.signal })
		).rejects.toMatchObject({ reason: 'cancelled', retryable: false });
		const cleanup = fetchImpl.mock.calls.find(
			([url, init]) => String(url).endsWith('/session/session-9') && init?.method === 'DELETE'
		);
		expect(cleanup).toBeDefined();
		expect(cleanup?.[1]?.signal?.aborted).toBe(false);
	});

	it('falls back to the default timeout for absent or nonsensical configuration', () => {
		expect(resolveModelTimeoutMs({ GUIDANCE_MODEL_TIMEOUT_MS: '45000' })).toBe(45_000);
		expect(resolveModelTimeoutMs({})).toBe(30_000);
		expect(resolveModelTimeoutMs({ GUIDANCE_MODEL_TIMEOUT_MS: '-5' })).toBe(30_000);
		expect(resolveModelTimeoutMs({ GUIDANCE_MODEL_TIMEOUT_MS: 'soon' })).toBe(30_000);
	});
});

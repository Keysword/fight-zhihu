import { describe, expect, it, vi } from 'vitest';

import { createModelClient, ModelClientError, resolveModelConfiguration } from './model-client';

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
});

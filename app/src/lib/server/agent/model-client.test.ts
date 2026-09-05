import { describe, expect, it, vi } from 'vitest';

import { createModelClient, ModelClientError, resolveModelConfiguration } from './model-client';

describe('model client', () => {
	it('falls back to Zhihu Direct Answer when only its access secret is configured', () => {
		expect(resolveModelConfiguration({ ZHIHU_ACCESS_SECRET: 'zhihu-secret' })).toEqual({
			url: 'https://developer.zhihu.com/v1/chat/completions',
			apiKey: 'zhihu-secret',
			model: 'zhida-agent',
			isZhihu: true
		});
	});

	it('sends only the portable request fields and returns assistant content', async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Promise.resolve(
				new Response(
					JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"type":"finish","summary":"完成"}' } }] }),
					{ status: 200 }
				)
			)
		);
		const client = createModelClient(
			{ url: 'https://example.com/v1/chat/completions', apiKey: 'key', model: 'agent', isZhihu: false },
			{ fetchImpl, now: () => 1_800_000_000_000 }
		);
		const messages = [{ role: 'user' as const, content: '分析这个案例' }];

		await expect(client.complete(messages)).resolves.toContain('finish');
		const [, options] = fetchImpl.mock.calls[0];
		expect(JSON.parse(String(options?.body))).toEqual({ model: 'agent', messages, stream: false });
		expect(options?.headers).toMatchObject({ Authorization: 'Bearer key' });
	});

	it('adds timestamp authentication for Zhihu and rejects empty responses', async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
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
});

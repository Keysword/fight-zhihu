import { describe, expect, it, vi } from 'vitest';

import { createZhihuClient, ZhihuApiError, ZhihuRateLimitError } from './client';

const successPayload = {
	Code: 0,
	Message: 'success',
	Data: {
		Items: [
			{
				Title: '新人住宿经验',
				ContentType: 'Answer',
				ContentID: '42',
				ContentText: '先确认 <em>入住资格</em>，再问房间。',
				Url: 'https://www.zhihu.com/answer/42?utm_source=openapi&foo=bar',
				AuthorName: '一位新人',
				EditTime: 1_725_000_000,
				AuthorityLevel: '2'
			}
		]
	}
};

describe('Zhihu search client', () => {
	it('uses the documented endpoint, query names, and authentication headers', async () => {
		const fetchImpl = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(JSON.stringify(successPayload), { status: 200 }))
		);
		const client = createZhihuClient({
			accessSecret: 'test-secret',
			fetchImpl,
			now: () => 1_800_000_123_456
		});

		const clues = await client.searchZhihu('新人 入住宿舍', 4);
		const [url, options] = fetchImpl.mock.calls[0];
		const requestUrl = new URL(String(url));

		expect(requestUrl.origin + requestUrl.pathname).toBe(
			'https://developer.zhihu.com/api/v1/content/zhihu_search'
		);
		expect(requestUrl.searchParams.get('Query')).toBe('新人 入住宿舍');
		expect(requestUrl.searchParams.get('Count')).toBe('4');
		expect(options?.headers).toMatchObject({
			Authorization: 'Bearer test-secret',
			'X-Request-Timestamp': '1800000123'
		});
		expect(clues[0]).toMatchObject({
			id: 'zhihu-42',
			title: '新人住宿经验',
			excerpt: '先确认 入住资格，再问房间。',
			url: 'https://www.zhihu.com/answer/42?foo=bar',
			author: '一位新人',
			authorityLevel: '2',
			source: 'zhihu'
		});
	});

	it('uses the global endpoint and caps result counts', async () => {
		const fetchImpl = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(JSON.stringify(successPayload), { status: 200 }))
		);
		const client = createZhihuClient({ accessSecret: 'test-secret', fetchImpl });
		await client.searchGlobal('异地落户 材料', 99);
		const requestUrl = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(requestUrl.pathname).toBe('/api/v1/content/global_search');
		expect(requestUrl.searchParams.get('Count')).toBe('20');
	});

	it('returns an empty clue list for an empty successful response', async () => {
		const fetchImpl = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ Code: 0, Message: 'success', Data: { Items: [] } }), {
					status: 200
				})
			)
		);
		const client = createZhihuClient({ accessSecret: 'test-secret', fetchImpl });
		await expect(client.searchZhihu('没有结果')).resolves.toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('surfaces platform and rate-limit failures without retrying', async () => {
		const platformFetch = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ Code: 20001, Message: '鉴权失败' }), { status: 200 })
			)
		);
		const limitedFetch = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response('too many requests', { status: 429 }))
		);

		await expect(
			createZhihuClient({ accessSecret: 'bad', fetchImpl: platformFetch }).searchZhihu('测试')
		).rejects.toBeInstanceOf(ZhihuApiError);
		await expect(
			createZhihuClient({ accessSecret: 'test', fetchImpl: limitedFetch }).searchZhihu('测试')
		).rejects.toBeInstanceOf(ZhihuRateLimitError);
		expect(platformFetch).toHaveBeenCalledTimes(1);
		expect(limitedFetch).toHaveBeenCalledTimes(1);
	});
});

describe('Zhihu search client cancellation and timeouts', () => {
	it('passes the search deadline and caller signal to the request', async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise<Response>((resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'TimeoutError'))
					);
				})
		);
		const client = createZhihuClient({ accessSecret: 'test-secret', fetchImpl });
		const caller = new AbortController();
		await expect(
			client.searchZhihu('超时验证', 3, { signal: caller.signal, timeoutMs: 60 })
		).rejects.toMatchObject({ name: 'ZhihuApiError', message: '知乎开放平台请求超时' });
	}, 2_000);

	it('reports a caller cancellation distinctly from its own timeout', async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		const client = createZhihuClient({ accessSecret: 'test-secret', fetchImpl });
		const caller = new AbortController();
		const pending = client.searchZhihu('取消验证', 3, { signal: caller.signal });
		const assertion = expect(pending).rejects.toMatchObject({ message: '本轮搜索已取消' });
		caller.abort();
		await assertion;
	});
});

import { env } from '$env/dynamic/private';

import type { ExternalClue } from '$lib/domain/types';
import type { ZhihuSearchItem, ZhihuSearchResponse } from './types';

const API_ORIGIN = 'https://developer.zhihu.com';

export class ZhihuApiError extends Error {
	constructor(
		message: string,
		readonly code?: number
	) {
		super(message);
		this.name = 'ZhihuApiError';
	}
}

export class ZhihuRateLimitError extends ZhihuApiError {
	constructor() {
		super('知乎开放平台请求过于频繁，请稍后再试', 429);
		this.name = 'ZhihuRateLimitError';
	}
}

export interface ZhihuClientOptions {
	accessSecret: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface ZhihuClient {
	searchZhihu(query: string, count?: number): Promise<ExternalClue[]>;
	searchGlobal(query: string, count?: number): Promise<ExternalClue[]>;
}

function cleanUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	for (const name of [...url.searchParams.keys()]) {
		if (name.toLowerCase().startsWith('utm_')) url.searchParams.delete(name);
	}
	return url.toString();
}

function cleanExcerpt(content: string): string {
	return content
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 500);
}

function mapItem(item: ZhihuSearchItem, source: 'zhihu' | 'global'): ExternalClue {
	return {
		id: `${source}-${item.ContentID}`,
		title: item.Title,
		excerpt: cleanExcerpt(item.ContentText),
		url: cleanUrl(item.Url),
		author: item.AuthorName || '未知作者',
		editedAt: Number.isFinite(item.EditTime) ? new Date(item.EditTime * 1_000).toISOString() : null,
		authorityLevel: item.AuthorityLevel || null,
		source,
		relevance: '这是外部经验线索，可用来补充提问方向',
		warning: '外部内容不是本案例事实，请向实际负责人核实'
	};
}

export function createZhihuClient(options: ZhihuClientOptions): ZhihuClient {
	if (!options.accessSecret.trim()) throw new ZhihuApiError('未配置知乎开放平台密钥');
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;

	async function search(
		path: '/api/v1/content/zhihu_search' | '/api/v1/content/global_search',
		query: string,
		count: number,
		source: 'zhihu' | 'global'
	): Promise<ExternalClue[]> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) throw new ZhihuApiError('搜索词不能为空', 10001);
		const maximum = source === 'zhihu' ? 10 : 20;
		const normalizedCount = Math.min(maximum, Math.max(1, Math.trunc(count)));
		const url = new URL(path, API_ORIGIN);
		url.searchParams.set('Query', normalizedQuery);
		url.searchParams.set('Count', String(normalizedCount));

		const response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${options.accessSecret}`,
				'X-Request-Timestamp': String(Math.floor(now() / 1_000)),
				'Content-Type': 'application/json'
			}
		});
		if (response.status === 429) throw new ZhihuRateLimitError();
		if (!response.ok) throw new ZhihuApiError(`知乎开放平台请求失败（HTTP ${response.status}）`);

		let payload: ZhihuSearchResponse;
		try {
			payload = (await response.json()) as ZhihuSearchResponse;
		} catch {
			throw new ZhihuApiError('知乎开放平台返回了无法解析的数据');
		}
		if (payload.Code !== 0)
			throw new ZhihuApiError(payload.Message || '知乎搜索失败', payload.Code);
		return (payload.Data?.Items ?? []).map((item) => mapItem(item, source));
	}

	return {
		searchZhihu: (query, count = 5) =>
			search('/api/v1/content/zhihu_search', query, count, 'zhihu'),
		searchGlobal: (query, count = 5) =>
			search('/api/v1/content/global_search', query, count, 'global')
	};
}

export function createConfiguredZhihuClient(): ZhihuClient {
	return createZhihuClient({ accessSecret: env.ZHIHU_ACCESS_SECRET ?? '' });
}

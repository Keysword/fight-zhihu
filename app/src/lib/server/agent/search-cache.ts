import type { ExternalClue } from '$lib/domain/types';

export const DEFAULT_SEARCH_CACHE_TTL_MS = 5 * 60_000;
export const MAX_CACHE_ENTRIES_PER_CASE = 20;
export const MAX_CACHE_CASES = 100;

export interface SearchCacheKey {
	source: 'zhihu' | 'global';
	/** 必须传入脱敏后的检索词。 */
	query: string;
	count: number;
}

interface SearchCacheCaseState {
	/** 插入顺序即淘汰顺序；条目超过上限时淘汰最旧项。 */
	entries: Map<string, { clues: ExternalClue[]; expiresAt: number }>;
	lastAccessAt: number;
}

export interface SearchCache {
	get(caseId: string, key: SearchCacheKey, now: number): ExternalClue[] | null;
	set(caseId: string, key: SearchCacheKey, clues: ExternalClue[], now: number): void;
}

/**
 * 单 runtime 实例内的有界短期搜索缓存：
 * 按 caseId 隔离、不落盘、不跨用户复用；失败/超时不缓存（由调用方保证只缓存成功结果）。
 */
export function createSearchCache(
	options: { ttlMs?: number; maxEntriesPerCase?: number; maxCases?: number } = {}
): SearchCache {
	const ttlMs = options.ttlMs ?? DEFAULT_SEARCH_CACHE_TTL_MS;
	const maxEntriesPerCase = options.maxEntriesPerCase ?? MAX_CACHE_ENTRIES_PER_CASE;
	const maxCases = options.maxCases ?? MAX_CACHE_CASES;
	const cases = new Map<string, SearchCacheCaseState>();

	function keyOf(key: SearchCacheKey): string {
		return JSON.stringify([key.source, key.query, key.count]);
	}

	function caseState(caseId: string): SearchCacheCaseState {
		const existing = cases.get(caseId);
		if (existing) return existing;
		// 案例数超限时淘汰最旧访问的案例。
		if (cases.size >= maxCases) {
			let oldestId: string | null = null;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [candidate, state] of cases) {
				if (state.lastAccessAt < oldestAt) {
					oldestAt = state.lastAccessAt;
					oldestId = candidate;
				}
			}
			if (oldestId !== null) cases.delete(oldestId);
		}
		const created: SearchCacheCaseState = { entries: new Map(), lastAccessAt: 0 };
		cases.set(caseId, created);
		return created;
	}

	return {
		get(caseId, key, now) {
			const state = cases.get(caseId);
			if (!state) return null;
			state.lastAccessAt = now;
			const entry = state.entries.get(keyOf(key));
			if (!entry) return null;
			if (now >= entry.expiresAt) {
				state.entries.delete(keyOf(key));
				return null;
			}
			return entry.clues;
		},
		set(caseId, key, clues, now) {
			const state = caseState(caseId);
			state.lastAccessAt = now;
			const cacheKey = keyOf(key);
			if (!state.entries.has(cacheKey) && state.entries.size >= maxEntriesPerCase) {
				const oldest = state.entries.keys().next();
				if (!oldest.done) state.entries.delete(oldest.value);
			}
			state.entries.set(cacheKey, { clues, expiresAt: now + ttlMs });
		}
	};
}

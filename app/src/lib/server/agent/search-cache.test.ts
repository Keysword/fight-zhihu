import { describe, expect, it } from 'vitest';

import type { ExternalClue } from '$lib/domain/types';
import { createSearchCache } from './search-cache';

function clue(id: string): ExternalClue {
	return {
		id,
		title: '相似经验',
		excerpt: '可分别确认申请与安排。',
		url: `https://example.com/${id}`,
		author: '外部作者',
		editedAt: null,
		authorityLevel: null,
		source: 'zhihu',
		relevance: '补充核实方向',
		warning: '外部经验不是本案例事实'
	};
}

describe('search cache', () => {
	it('returns the cached clues for the same case and key', () => {
		const cache = createSearchCache();
		cache.set(
			'case-1',
			{ source: 'zhihu', query: '宿舍 入住', count: 3 },
			[clue('zhihu-1')],
			1_000
		);
		expect(cache.get('case-1', { source: 'zhihu', query: '宿舍 入住', count: 3 }, 2_000)).toEqual([
			clue('zhihu-1')
		]);
	});

	it('isolates cases from each other', () => {
		const cache = createSearchCache();
		cache.set('case-1', { source: 'zhihu', query: '宿舍', count: 3 }, [clue('zhihu-1')], 1_000);
		expect(cache.get('case-2', { source: 'zhihu', query: '宿舍', count: 3 }, 1_001)).toBeNull();
	});

	it('distinguishes keys by source, redacted query and count', () => {
		const cache = createSearchCache();
		cache.set('case-1', { source: 'zhihu', query: '宿舍', count: 3 }, [clue('zhihu-1')], 1_000);
		expect(cache.get('case-1', { source: 'global', query: '宿舍', count: 3 }, 1_001)).toBeNull();
		expect(cache.get('case-1', { source: 'zhihu', query: '宿舍', count: 5 }, 1_001)).toBeNull();
		expect(cache.get('case-1', { source: 'zhihu', query: '钥匙', count: 3 }, 1_001)).toBeNull();
	});

	it('drops entries after the TTL expires', () => {
		const cache = createSearchCache({ ttlMs: 300_000 });
		cache.set('case-1', { source: 'zhihu', query: '宿舍', count: 3 }, [clue('zhihu-1')], 1_000);
		expect(cache.get('case-1', { source: 'zhihu', query: '宿舍', count: 3 }, 300_999)).toEqual([
			clue('zhihu-1')
		]);
		expect(cache.get('case-1', { source: 'zhihu', query: '宿舍', count: 3 }, 301_000)).toBeNull();
	});

	it('evicts the oldest entry per case beyond the per-case limit', () => {
		const cache = createSearchCache({ maxEntriesPerCase: 2 });
		cache.set('case-1', { source: 'zhihu', query: 'a', count: 3 }, [clue('zhihu-a')], 1_000);
		cache.set('case-1', { source: 'zhihu', query: 'b', count: 3 }, [clue('zhihu-b')], 1_001);
		cache.set('case-1', { source: 'zhihu', query: 'c', count: 3 }, [clue('zhihu-c')], 1_002);
		expect(cache.get('case-1', { source: 'zhihu', query: 'a', count: 3 }, 1_003)).toBeNull();
		expect(cache.get('case-1', { source: 'zhihu', query: 'b', count: 3 }, 1_004)).toEqual([
			clue('zhihu-b')
		]);
		expect(cache.get('case-1', { source: 'zhihu', query: 'c', count: 3 }, 1_005)).toEqual([
			clue('zhihu-c')
		]);
	});

	it('evicts the least recently used case beyond the case limit', () => {
		const cache = createSearchCache({ maxCases: 2 });
		cache.set('case-1', { source: 'zhihu', query: 'q', count: 3 }, [clue('zhihu-1')], 1_000);
		cache.set('case-2', { source: 'zhihu', query: 'q', count: 3 }, [clue('zhihu-2')], 1_001);
		// 访问 case-1，使 case-2 成为最旧案例。
		cache.get('case-1', { source: 'zhihu', query: 'q', count: 3 }, 1_002);
		cache.set('case-3', { source: 'zhihu', query: 'q', count: 3 }, [clue('zhihu-3')], 1_003);
		expect(cache.get('case-1', { source: 'zhihu', query: 'q', count: 3 }, 1_004)).toEqual([
			clue('zhihu-1')
		]);
		expect(cache.get('case-2', { source: 'zhihu', query: 'q', count: 3 }, 1_005)).toBeNull();
		expect(cache.get('case-3', { source: 'zhihu', query: 'q', count: 3 }, 1_006)).toEqual([
			clue('zhihu-3')
		]);
	});
});

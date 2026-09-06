import { describe, expect, it } from 'vitest';
import { staleAppCacheKeys } from './cache-policy';

describe('PWA cache policy', () => {
	it('deletes only older Background Board caches on a shared origin', () => {
		expect(
			staleAppCacheKeys(
				['background-board-old', 'background-board-current', 'another-project-v3'],
				'background-board-current'
			)
		).toEqual(['background-board-old']);
	});
});

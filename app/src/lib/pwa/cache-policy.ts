export const APP_CACHE_PREFIX = 'background-board-';

export function staleAppCacheKeys(keys: string[], current: string): string[] {
	return keys.filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== current);
}

import { describe, expect, it } from 'vitest';

import { guidanceModeEnabled } from './app-context';

describe('guidance mode configuration', () => {
	it('enables the server-driven mode only for the exact value 1', () => {
		expect(guidanceModeEnabled('1')).toBe(true);
		expect(guidanceModeEnabled('true')).toBe(false);
		expect(guidanceModeEnabled('0')).toBe(false);
		expect(guidanceModeEnabled(undefined)).toBe(false);
	});
});

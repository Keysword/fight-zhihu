import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runGuidance, assertRateLimit } = vi.hoisted(() => ({
	runGuidance: vi.fn(),
	assertRateLimit: vi.fn()
}));

vi.mock('$lib/server/app-context', () => ({
	getCaseService: () => ({ runGuidance })
}));
vi.mock('$lib/server/rate-limit', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/rate-limit')>();
	return { ...original, assertRateLimit };
});

import { POST } from './+server';

describe('POST /api/cases/[id]/guidance', () => {
	beforeEach(() => {
		runGuidance.mockReset();
		assertRateLimit.mockReset();
	});

	it('accepts no request body, rate limits, and runs guidance', async () => {
		runGuidance.mockResolvedValue({ run: { outcome: 'ready' } });
		const request = new Request('http://localhost/api/cases/case-1/guidance', {
			method: 'POST'
		});

		const response = await POST({ params: { id: 'case-1' }, request } as never);

		expect(assertRateLimit).toHaveBeenCalledWith(request, 'run-guidance', {
			maximum: 10,
			windowMs: 10 * 60_000
		});
		expect(runGuidance).toHaveBeenCalledWith('case-1');
		expect(response.status).toBe(200);
	});
});

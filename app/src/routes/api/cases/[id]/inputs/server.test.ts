import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appendCaseInput, assertRateLimit } = vi.hoisted(() => ({
	appendCaseInput: vi.fn(),
	assertRateLimit: vi.fn()
}));

vi.mock('$lib/server/app-context', () => ({
	getCaseService: () => ({ appendCaseInput })
}));
vi.mock('$lib/server/rate-limit', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/rate-limit')>();
	return { ...original, assertRateLimit };
});

import { POST } from './+server';

describe('POST /api/cases/[id]/inputs', () => {
	beforeEach(() => {
		appendCaseInput.mockReset();
		assertRateLimit.mockReset();
	});

	it('reads JSON, rate limits, and saves without running analysis', async () => {
		appendCaseInput.mockReturnValue({ outcome: 'inserted' });
		const body = {
			kind: 'context',
			content: '新增情况',
			guidanceId: null,
			requestId: '11111111-1111-4111-8111-111111111111',
			replacements: []
		};
		const request = new Request('http://localhost/api/cases/case-1/inputs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});

		const response = await POST({ params: { id: 'case-1' }, request } as never);

		expect(assertRateLimit).toHaveBeenCalledWith(request, 'append-case-input', {
			maximum: 30,
			windowMs: 10 * 60_000
		});
		expect(appendCaseInput).toHaveBeenCalledWith('case-1', body);
		expect(response.status).toBe(201);
	});
});

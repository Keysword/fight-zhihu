import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getGuidance } = vi.hoisted(() => ({ getGuidance: vi.fn() }));

vi.mock('$lib/server/app-context', () => ({
	getCaseService: () => ({ getGuidance })
}));

import { GET } from './+server';

describe('GET /api/cases/[id]/guidance/[guidanceId]', () => {
	beforeEach(() => getGuidance.mockReset());

	it('loads one guidance detail within its case scope', async () => {
		getGuidance.mockReturnValue({ id: 'guidance-1' });

		const response = await GET({
			params: { id: 'case-1', guidanceId: 'guidance-1' }
		} as never);

		expect(getGuidance).toHaveBeenCalledWith('case-1', 'guidance-1');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { id: 'guidance-1' }
		});
	});
});

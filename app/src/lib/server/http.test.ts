import { describe, expect, it } from 'vitest';

import { GuidanceReferenceError, IdempotencyConflictError } from '$lib/server/cases/repository';
import { apiError } from './http';
import { GuidanceModeDisabledError } from './services/case-service';

async function errorPayload(response: Response) {
	return (await response.json()) as {
		ok: false;
		error: { code: string; message: string };
	};
}

describe('apiError', () => {
	it('maps input request id conflicts to a stable 409 response', async () => {
		const response = apiError(new IdempotencyConflictError('11111111-1111-4111-8111-111111111111'));

		expect(response.status).toBe(409);
		expect(await errorPayload(response)).toEqual({
			ok: false,
			error: {
				code: 'IDEMPOTENCY_CONFLICT',
				message: '该请求标识已用于不同的输入'
			}
		});
	});

	it('uses the same opaque response for missing and cross-case guidance references', async () => {
		const response = apiError(new GuidanceReferenceError());

		expect(response.status).toBe(400);
		expect(await errorPayload(response)).toEqual({
			ok: false,
			error: {
				code: 'GUIDANCE_REFERENCE_INVALID',
				message: '指导引用无效或不属于当前案例'
			}
		});
	});

	it('maps disabled guided endpoints to a stable 404 response', async () => {
		const response = apiError(new GuidanceModeDisabledError());

		expect(response.status).toBe(404);
		expect(await errorPayload(response)).toEqual({
			ok: false,
			error: {
				code: 'GUIDANCE_MODE_DISABLED',
				message: '指导模式未启用'
			}
		});
	});
});

import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';
import { assertRateLimit } from '$lib/server/rate-limit';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		assertRateLimit(request, 'run-agent', { maximum: 10, windowMs: 10 * 60_000 });
		return ok(await getCaseService().runCase(params.id));
	} catch (error) {
		return apiError(error);
	}
};

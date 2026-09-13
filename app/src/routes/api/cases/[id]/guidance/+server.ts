import type { RequestHandler } from './$types';
import { getCaseService, guidanceRunRateLimit } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';
import { assertRateLimit } from '$lib/server/rate-limit';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		assertRateLimit(request, 'run-guidance', guidanceRunRateLimit());
		return ok(await getCaseService().runGuidance(params.id));
	} catch (error) {
		return apiError(error);
	}
};

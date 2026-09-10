import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';
import { assertRateLimit } from '$lib/server/rate-limit';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		assertRateLimit(request, 'confirm-evidence', { maximum: 30, windowMs: 10 * 60_000 });
		return ok(getCaseService().confirmEvidence(params.id, params.evidenceId));
	} catch (error) {
		return apiError(error);
	}
};

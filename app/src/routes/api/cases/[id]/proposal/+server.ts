import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok, readJsonBody } from '$lib/server/http';
import { assertRateLimit } from '$lib/server/rate-limit';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		assertRateLimit(request, 'review-proposal', { maximum: 20, windowMs: 10 * 60_000 });
		return ok(
			getCaseService().reviewBoardProposal(params.id, (await readJsonBody(request)) as never)
		);
	} catch (error) {
		return apiError(error);
	}
};

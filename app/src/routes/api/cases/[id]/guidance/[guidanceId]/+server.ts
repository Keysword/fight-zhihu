import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return ok(getCaseService().getGuidance(params.id, params.guidanceId));
	} catch (error) {
		return apiError(error);
	}
};

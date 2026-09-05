import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return ok(getCaseService().getCase(params.id));
	} catch (error) {
		return apiError(error);
	}
};

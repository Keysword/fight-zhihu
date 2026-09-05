import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';

export const GET: RequestHandler = async () => {
	try {
		return ok(getCaseService().health());
	} catch (error) {
		return apiError(error);
	}
};

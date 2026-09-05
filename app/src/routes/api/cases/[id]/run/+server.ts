import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';

export const POST: RequestHandler = async ({ params }) => {
	try {
		return ok(await getCaseService().runCase(params.id));
	} catch (error) {
		return apiError(error);
	}
};

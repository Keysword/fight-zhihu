import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';

export const POST: RequestHandler = async () => {
	try {
		return ok(await getCaseService().createDemo(), { status: 201 });
	} catch (error) {
		return apiError(error);
	}
};

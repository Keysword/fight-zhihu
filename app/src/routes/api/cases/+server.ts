import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok, readJsonBody } from '$lib/server/http';

export const GET: RequestHandler = async () => {
	try {
		return ok(getCaseService().listCases());
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		return ok(getCaseService().createCase((await readJsonBody(request)) as never), { status: 201 });
	} catch (error) {
		return apiError(error);
	}
};

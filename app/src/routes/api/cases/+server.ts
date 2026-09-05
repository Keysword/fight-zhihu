import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok, readJsonBody } from '$lib/server/http';
import { assertRateLimit } from '$lib/server/rate-limit';

export const POST: RequestHandler = async ({ request }) => {
	try {
		assertRateLimit(request, 'create-case', { maximum: 10, windowMs: 10 * 60_000 });
		return ok(getCaseService().createCase((await readJsonBody(request)) as never), { status: 201 });
	} catch (error) {
		return apiError(error);
	}
};

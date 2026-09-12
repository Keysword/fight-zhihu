import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok, readJsonBody } from '$lib/server/http';
import { assertRateLimit } from '$lib/server/rate-limit';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		assertRateLimit(request, 'append-case-input', { maximum: 30, windowMs: 10 * 60_000 });
		const result = getCaseService().appendCaseInput(
			params.id,
			(await readJsonBody(request)) as never
		);
		return ok(result, { status: result.outcome === 'inserted' ? 201 : 200 });
	} catch (error) {
		return apiError(error);
	}
};

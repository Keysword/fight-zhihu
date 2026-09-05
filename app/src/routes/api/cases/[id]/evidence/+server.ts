import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok, readJsonBody } from '$lib/server/http';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		return ok(
			await getCaseService().appendEvidenceAndRun(
				params.id,
				(await readJsonBody(request)) as never
			),
			{ status: 201 }
		);
	} catch (error) {
		return apiError(error);
	}
};

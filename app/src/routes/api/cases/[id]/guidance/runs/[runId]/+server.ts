import type { RequestHandler } from './$types';
import { getCaseService } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';

/**
 * 查询一轮整理的进度。轮询不计入 run-guidance 限流：正常等待一轮长推理
 * 就会产生几十次查询，把它算进额度会让用户在真正需要重试时被挡住。
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		return ok(getCaseService().getGuidanceRun(params.id, params.runId));
	} catch (error) {
		return apiError(error);
	}
};

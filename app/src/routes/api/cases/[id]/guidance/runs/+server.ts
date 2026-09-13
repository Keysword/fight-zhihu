import type { RequestHandler } from './$types';
import { getCaseService, guidanceRunRateLimit } from '$lib/server/app-context';
import { apiError, ok } from '$lib/server/http';
import { assertRateLimit } from '$lib/server/rate-limit';

/**
 * 启动一轮整理并立即返回 runId，由客户端轮询进度。
 *
 * 已有在飞运行时直接复用，且不再计一次限流：用户因为看不到进度而连点按钮，
 * 不应该换来一个与真实原因无关的 429。
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const service = getCaseService();
		const active = service.activeGuidanceRun(params.id);
		if (active) return ok({ runId: active.runId, reused: true });

		assertRateLimit(request, 'run-guidance', guidanceRunRateLimit());
		return ok(service.startGuidanceRun(params.id));
	} catch (error) {
		return apiError(error);
	}
};

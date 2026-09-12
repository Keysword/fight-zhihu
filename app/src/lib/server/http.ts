import { json } from '@sveltejs/kit';
import { z } from 'zod';

import { AgentLimitError, runErrorDetail } from '$lib/server/agent/runtime';
import { AgentProtocolError } from '$lib/server/agent/protocol';
import { AgentSafetyError } from '$lib/server/agent/tools';
import { ModelClientError, ModelConfigurationError } from '$lib/server/agent/model-client';
import {
	CaseNotFoundError,
	EvidenceNotFoundError,
	GuidanceReferenceError,
	IdempotencyConflictError,
	RevisionConflictError
} from '$lib/server/cases/repository';
import { ZhihuApiError, ZhihuRateLimitError } from '$lib/server/zhihu/client';
import { RateLimitExceededError } from '$lib/server/rate-limit';
import { GuidanceModeDisabledError } from '$lib/server/services/case-service';

const MAX_BODY_BYTES = 100_000;

export async function readJsonBody(request: Request): Promise<unknown> {
	const declaredLength = Number(request.headers.get('content-length') ?? 0);
	if (declaredLength > MAX_BODY_BYTES) throw new RequestBodyError('请求内容过大');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new RequestBodyError('请求内容不是有效 JSON');
	}
	if (JSON.stringify(body).length > MAX_BODY_BYTES) throw new RequestBodyError('请求内容过大');
	return body;
}

export class RequestBodyError extends Error {}

export function ok(data: unknown, init?: ResponseInit): Response {
	return json({ ok: true, data }, init);
}

export function apiError(error: unknown): Response {
	let status = 500;
	let code = 'INTERNAL_ERROR';
	let message = '服务暂时遇到问题，请稍后再试';

	if (error instanceof z.ZodError || error instanceof RequestBodyError) {
		status = 400;
		code = 'INVALID_REQUEST';
		message =
			error instanceof z.ZodError ? error.issues[0]?.message || '输入不完整' : error.message;
	} else if (error instanceof CaseNotFoundError || error instanceof EvidenceNotFoundError) {
		status = 404;
		code = error instanceof EvidenceNotFoundError ? 'EVIDENCE_NOT_FOUND' : 'CASE_NOT_FOUND';
		message = error.message;
	} else if (error instanceof RevisionConflictError) {
		status = 409;
		code = 'REVISION_CONFLICT';
		message = error.message;
	} else if (error instanceof IdempotencyConflictError) {
		status = 409;
		code = 'IDEMPOTENCY_CONFLICT';
		message = '该请求标识已用于不同的输入';
	} else if (error instanceof GuidanceReferenceError) {
		status = 400;
		code = 'GUIDANCE_REFERENCE_INVALID';
		message = '指导引用无效或不属于当前案例';
	} else if (error instanceof GuidanceModeDisabledError) {
		status = 404;
		code = 'GUIDANCE_MODE_DISABLED';
		message = error.message;
	} else if (error instanceof ZhihuRateLimitError) {
		status = 429;
		code = 'ZHIHU_RATE_LIMIT';
		message = error.message;
	} else if (error instanceof RateLimitExceededError) {
		status = 429;
		code = 'RATE_LIMITED';
		message = error.message;
	} else if (error instanceof ModelConfigurationError) {
		status = 503;
		code = 'MODEL_NOT_CONFIGURED';
		message = error.message;
	} else if (error instanceof AgentSafetyError || error instanceof AgentProtocolError) {
		status = 502;
		code = 'AGENT_OUTPUT_REJECTED';
		const detail = runErrorDetail(error);
		return json(
			{
				ok: false,
				error: { code, message: detail.summary, title: detail.title, suggestion: detail.suggestion }
			},
			{ status }
		);
	} else if (error instanceof AgentLimitError) {
		status = 502;
		code = 'AGENT_LIMIT_REACHED';
		message = error.message;
	} else if (error instanceof ModelClientError || error instanceof ZhihuApiError) {
		status = 502;
		code = 'UPSTREAM_UNAVAILABLE';
		message = error.message;
	}

	return json({ ok: false, error: { code, message } }, { status });
}

import { resolve } from 'node:path';
import { env } from '$env/dynamic/private';

import { createAgentRuntime } from '$lib/server/agent/runtime';
import { createGuidanceRuntime } from '$lib/server/agent/guidance-runtime';
import { createModelClient, resolveModelConfiguration } from '$lib/server/agent/model-client';
import { createCaseRepository } from '$lib/server/cases/repository';
import { createCaseService, type CaseService } from '$lib/server/services/case-service';
import { createZhihuClient, ZhihuApiError, type ZhihuClient } from '$lib/server/zhihu/client';

let service: CaseService | undefined;

export function guidanceModeEnabled(value: string | undefined): boolean {
	return value === '1';
}

function unavailableZhihuClient(): ZhihuClient {
	return {
		searchZhihu: async () => {
			throw new ZhihuApiError('尚未配置知乎开放平台密钥');
		},
		searchGlobal: async () => {
			throw new ZhihuApiError('尚未配置知乎开放平台密钥');
		}
	};
}

export function getCaseService(): CaseService {
	if (service) return service;
	const dataDirectory = env.BACKGROUND_BOARD_DATA_DIR || resolve(process.cwd(), 'data');
	const repository = createCaseRepository(resolve(dataDirectory, 'background-board.sqlite'));
	const modelConfiguration = resolveModelConfiguration(env);
	const model = modelConfiguration ? createModelClient(modelConfiguration) : null;
	const zhihu = env.ZHIHU_ACCESS_SECRET
		? createZhihuClient({ accessSecret: env.ZHIHU_ACCESS_SECRET })
		: unavailableZhihuClient();
	const runner = createAgentRuntime({ repository, model, zhihu });
	const guidanceRunner = createGuidanceRuntime({ repository, model, zhihu });
	service = createCaseService({
		repository,
		runner,
		guidanceRunner,
		configuration: {
			guidanceMode: guidanceModeEnabled(env.BACKGROUND_BOARD_GUIDANCE_V2),
			modelConfigured: Boolean(modelConfiguration),
			zhihuConfigured: Boolean(env.ZHIHU_ACCESS_SECRET),
			version: env.APP_VERSION || '0.1.0'
		}
	});
	return service;
}

import { resolve } from 'node:path';
import { env } from '$env/dynamic/private';

import { createAgentRuntime } from '$lib/server/agent/runtime';
import {
	createGuidanceRuntime,
	DEFAULT_MAX_MODEL_RETRIES,
	DEFAULT_RUN_BUDGET_MS
} from '$lib/server/agent/guidance-runtime';
import {
	createModelClient,
	resolveModelConfiguration,
	resolveModelTimeoutMs,
	type ModelClient,
	type ModelConfiguration
} from '$lib/server/agent/model-client';
import { createSdkModelClient, type SdkConfiguration } from '$lib/server/agent/sdk-model-client';
import { createCaseRepository } from '$lib/server/cases/repository';
import { createCaseService, type CaseService } from '$lib/server/services/case-service';
import { createZhihuClient, ZhihuApiError, type ZhihuClient } from '$lib/server/zhihu/client';

let service: CaseService | undefined;

export function guidanceModeEnabled(value: string | undefined): boolean {
	return value === '1';
}

export function positiveIntegerOr(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function nonNegativeIntegerOr(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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

export class AgentTransportConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentTransportConfigurationError';
	}
}

export interface AgentTransportSelection {
	transport: 'legacy' | 'sdk';
	/** legacy 路由的模型配置；sdk 模式下为 null，不得偷偷回落到知乎直答。 */
	modelConfiguration: ModelConfiguration | null;
	sdkConfiguration: SdkConfiguration | null;
}

/** AGENT_TRANSPORT 只接受 legacy（默认，完全保留原优先级）与 sdk（显式直连）。 */
export function selectAgentTransport(
	values: Record<string, string | undefined>
): AgentTransportSelection {
	const raw = values.AGENT_TRANSPORT;
	if (raw === undefined || raw === '' || raw === 'legacy') {
		return { transport: 'legacy', modelConfiguration: resolveModelConfiguration(values), sdkConfiguration: null };
	}
	if (raw !== 'sdk') {
		throw new AgentTransportConfigurationError(
			`AGENT_TRANSPORT 配置无效：${raw}（仅支持 legacy 或 sdk）`
		);
	}
	const baseURL = values.AGENT_SDK_BASE_URL?.trim();
	const apiKey = values.AGENT_API_KEY?.trim();
	const model = values.AGENT_MODEL?.trim();
	if (!baseURL || !apiKey || !model) {
		const missing = [
			baseURL ? null : 'AGENT_SDK_BASE_URL',
			apiKey ? null : 'AGENT_API_KEY',
			model ? null : 'AGENT_MODEL'
		].filter((name): name is string => name !== null);
		throw new AgentTransportConfigurationError(
			`AGENT_TRANSPORT=sdk 需要显式配置：${missing.join('、')} 缺失，不自动回落旧路由或知乎直答`
		);
	}
	const rawStream = values.AGENT_SDK_STREAM;
	if (rawStream !== undefined && rawStream !== '' && rawStream !== '0' && rawStream !== '1') {
		throw new AgentTransportConfigurationError(
			`AGENT_SDK_STREAM 配置无效：${rawStream}（仅支持 0 或 1）`
		);
	}
	return {
		transport: 'sdk',
		modelConfiguration: null,
		sdkConfiguration: {
			baseURL,
			apiKey,
			model,
			stream: rawStream === '1'
		}
	};
}

export function createAgentModelClient(
	selection: AgentTransportSelection,
	timeoutMs: number
): ModelClient | null {
	if (selection.transport === 'sdk') {
		return createSdkModelClient(selection.sdkConfiguration as SdkConfiguration);
	}
	return selection.modelConfiguration
		? createModelClient(selection.modelConfiguration, { timeoutMs })
		: null;
}

export function getCaseService(): CaseService {
	if (service) return service;
	const dataDirectory = env.BACKGROUND_BOARD_DATA_DIR || resolve(process.cwd(), 'data');
	const repository = createCaseRepository(resolve(dataDirectory, 'background-board.sqlite'));
	const selection = selectAgentTransport(env);
	const modelTimeoutMs = resolveModelTimeoutMs(env);
	const model = createAgentModelClient(selection, modelTimeoutMs);
	const zhihu = env.ZHIHU_ACCESS_SECRET
		? createZhihuClient({ accessSecret: env.ZHIHU_ACCESS_SECRET })
		: unavailableZhihuClient();
	const runner = createAgentRuntime({ repository, model, zhihu });
	const guidanceRunner = createGuidanceRuntime({
		repository,
		model,
		zhihu,
		modelTimeoutMs,
		runBudgetMs: positiveIntegerOr(env.GUIDANCE_RUN_BUDGET_MS, DEFAULT_RUN_BUDGET_MS),
		maxModelRetries: nonNegativeIntegerOr(env.GUIDANCE_MODEL_MAX_RETRIES, DEFAULT_MAX_MODEL_RETRIES)
	});
	service = createCaseService({
		repository,
		runner,
		guidanceRunner,
		configuration: {
			guidanceMode: guidanceModeEnabled(env.BACKGROUND_BOARD_GUIDANCE_V2),
			modelConfigured:
				Boolean(selection.modelConfiguration) || Boolean(selection.sdkConfiguration),
			zhihuConfigured: Boolean(env.ZHIHU_ACCESS_SECRET),
			version: env.APP_VERSION || '0.1.0'
		}
	});
	return service;
}

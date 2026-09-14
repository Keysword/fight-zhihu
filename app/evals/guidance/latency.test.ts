import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CaseInput, GuidanceSnapshot } from '$lib/domain/guidance';
import type { Evidence } from '$lib/domain/types';
import { createGuidanceRuntime } from '$lib/server/agent/guidance-runtime';
import {
	LEGACY_GUIDANCE_POLICY,
	resolveGuidancePolicy,
	type GuidancePolicy
} from '$lib/server/agent/guidance-policy';
import { buildGuidanceMessages } from '$lib/server/agent/guidance-prompt';
import { parseGuidanceActionEnvelope } from '$lib/server/agent/guidance-protocol';
import type { ModelClient, ModelMessage } from '$lib/server/agent/model-client';
import { createZhihuClient, type ZhihuClient } from '$lib/server/zhihu/client';
import {
	BudgetExhaustedError,
	createEvalRuntimeDependencies,
	EvalSession,
	isolatedRepository,
	latencyScenarios,
	materialiseScenario,
	armsForTransportPhase,
	type ArmDefinition,
	type EvaluationPhase
} from './harness';

const REAL_EVAL = process.env.GUIDANCE_REAL_EVAL === '1';
const ACTIVE_PHASE = (process.env.GUIDANCE_EVAL_PHASE ?? '') as EvaluationPhase | '';

/** 默认（GUIDANCE_REAL_EVAL !== '1'）整个评测 suite 跳过；普通单测绝不触网。 */
function phaseSuite(name: EvaluationPhase, body: () => void): ReturnType<typeof describe> {
	if (!REAL_EVAL || ACTIVE_PHASE !== name) return describe.skip(name, body);
	return describe(name, body);
}

function frozenMessages(scenarioId: string): { messages: ModelMessage[]; promptHash: string } {
	const scenario = latencyScenarios.find((candidate) => candidate.id === scenarioId);
	if (!scenario) throw new Error(`未知场景：${scenarioId}`);
	const evidence: Evidence[] = scenario.evidence.map((item, index) => ({
		id: `evidence-${index + 1}`,
		kind: 'notice',
		content: item.content,
		sourceLabel: item.sourceLabel,
		occurredAt: null,
		confirmation: 'self_reported'
	}));
	const inputs: CaseInput[] = scenario.inputs.map((item, index) => ({
		id: `input-${index + 1}`,
		caseId: scenario.id,
		contextRevision: index + 1,
		kind: item.kind,
		content: item.content,
		guidanceId: null,
		requestId: randomUUID(),
		createdAt: new Date(0).toISOString()
	}));
	const messages = buildGuidanceMessages({
		case: {
			id: scenario.id,
			title: scenario.title,
			goal: scenario.goal,
			confusion: scenario.confusion,
			contextRevision: inputs.length
		},
		evidence,
		inputs,
		externalClues: [],
		priorGuidance: null,
		referencedGuidance: []
	});
	return { messages, promptHash: `${scenario.id}:${inputs.length + evidence.length}` };
}

function unavailableZhihu(): ZhihuClient {
	return {
		searchZhihu: async () => {
			throw new Error('本阶段不使用真实搜索');
		},
		searchGlobal: async () => {
			throw new Error('本阶段不使用真实搜索');
		}
	};
}

function firstContentOf(modelCalls: Array<Record<string, unknown>>): number | null {
	const values = modelCalls
		.map((call) => call.firstContentMs)
		.filter((value): value is number => typeof value === 'number');
	return values.length > 0 ? Math.min(...values) : null;
}

function finishedPayloadFor(
	repository: ReturnType<typeof isolatedRepository>,
	caseId: string,
	runId: string
): Record<string, unknown> {
	const event = repository
		.listEvents(caseId)
		.filter((item) => item.type === 'guidance.run.finished')
		.find((item) => (item.payload as { runId?: string }).runId === runId);
	return (event?.payload ?? {}) as Record<string, unknown>;
}

interface RunOutcome {
	result: Awaited<ReturnType<ReturnType<typeof createGuidanceRuntime>['run']>>;
	payload: Record<string, unknown>;
}

/** 通过真实 runtime 执行一整轮，只注入被测依赖，不绕过业务校验。 */
async function runFullGuidance(options: {
	session: EvalSession;
	arm: ArmDefinition;
	policy: GuidancePolicy;
	scenarioId: string;
	repeat: number;
	cache: unknown;
}): Promise<RunOutcome | 'budget'> {
	const { session, arm, policy, scenarioId, repeat } = options;
	const repository = isolatedRepository();
	const materialised = materialiseScenario(
		repository,
		latencyScenarios.find((s) => s.id === scenarioId)!
	);
	const configurationHash = `${session.commit}:${arm.name}:${policy.mode}`;
	const model = arm.createClient({ onModelRequest: () => {} });
	const countedModel: ModelClient | null = model
		? {
				complete: (messages, callOptions) => {
					session.reserveModelRequests(1);
					return model.complete(messages, {
						...callOptions,
						timeoutMs: callOptions?.timeoutMs ?? policy.modelTimeoutMs
					});
				}
			}
		: null;
	const runtime = createEvalRuntimeDependencies({
		repository,
		model: countedModel,
		policy,
		zhihu: unavailableZhihu()
	});
	const startedAt = Date.now();
	const result = await runtime.run(materialised.caseId);
	const payload = finishedPayloadFor(repository, materialised.caseId, result.runId);
	const modelCalls = (payload.modelCalls ?? []) as Array<Record<string, unknown>>;
	session.recordRow({
		sampleId: `${session.phase}-${arm.name}-${scenarioId}-r${repeat}-${result.runId.slice(0, 8)}`,
		phase: session.phase,
		arm: arm.name,
		caseId: scenarioId,
		repeat,
		commit: session.commit,
		sdkVersion: session.sdkVersion,
		modelLabel: arm.modelLabel,
		promptHash: materialised.promptHash,
		configurationHash,
		outcome: result.outcome,
		totalMs: typeof payload.totalMs === 'number' ? payload.totalMs : Date.now() - startedAt,
		queueMs: typeof payload.queueMs === 'number' ? payload.queueMs : 0,
		modelAttempts: modelCalls.length,
		logicalSteps: new Set(modelCalls.map((call) => call.index)).size,
		searchRequests: (payload.searches as unknown[] | undefined)?.length ?? 0,
		searchCacheHits: 0,
		repairCount: typeof payload.repairCount === 'number' ? payload.repairCount : 0,
		firstContentMs: firstContentOf(modelCalls),
		errorCode: result.error?.code ?? null
	});
	session.recordAttempts(`${arm.name}-${scenarioId}-r${repeat}`, payload);
	session.recordOutput(
		session.phase,
		arm.name,
		scenarioId,
		repeat,
		result.guidance as GuidanceSnapshot | null
	);
	return { result, payload };
}

phaseSuite('smoke', () => {
	it('confirms one legal guidance through the SDK path', async () => {
		const session = new EvalSession({ phase: 'smoke', maxModelRequests: 4 });
		const sdkArm = armsForTransportPhase().find((arm) => arm.transport === 'sdk');
		expect(sdkArm, 'AGENT_SDK_* 评测配置缺失').toBeTruthy();
		const outcome = await runFullGuidance({
			session: session as EvalSession,
			arm: sdkArm as ArmDefinition,
			policy: LEGACY_GUIDANCE_POLICY,
			scenarioId: 'eval-arrangement-explicit',
			repeat: 1,
			cache: null
		});
		expect(outcome).not.toBe('budget');
		const { result } = outcome as RunOutcome;
		expect(['ready', 'needs_input']).toContain(result.outcome);
	});

	it('confirms one legal guidance through the legacy http path', async () => {
		const session = new EvalSession({ phase: 'smoke', maxModelRequests: 4 });
		const legacyArm = armsForTransportPhase().find((arm) => arm.transport === 'legacy-http');
		expect(legacyArm, 'AGENT_API_URL 评测配置缺失').toBeTruthy();
		const outcome = await runFullGuidance({
			session: session as EvalSession,
			arm: legacyArm as ArmDefinition,
			policy: LEGACY_GUIDANCE_POLICY,
			scenarioId: 'eval-arrangement-explicit',
			repeat: 1,
			cache: null
		});
		expect(outcome).not.toBe('budget');
		const { result } = outcome as RunOutcome;
		expect(['ready', 'needs_input']).toContain(result.outcome);
	});
});

phaseSuite('transport', () => {
	const scenarioIds = latencyScenarios.map((scenario) => scenario.id);
	const session = new EvalSession({ phase: 'transport', maxModelRequests: 60 });
	const arms = armsForTransportPhase().filter(
		(arm) => arm.transport === 'sdk' || arm.transport === 'legacy-http'
	);
	const optionalOpenCode = armsForTransportPhase().find((arm) => arm.transport === 'opencode');
	const configuredArms = optionalOpenCode ? [...arms, optionalOpenCode] : arms;

	it('warms up each configured arm once (recorded, excluded from main statistics)', async () => {
		for (const arm of configuredArms) {
			const { messages } = frozenMessages('eval-arrangement-explicit');
			const client = arm.createClient({ onModelRequest: () => session.reserveModelRequests(1) });
			expect(client, `${arm.name} 臂配置缺失`).toBeTruthy();
			const startedAt = Date.now();
			try {
				await (client as ModelClient).complete(messages, { timeoutMs: 90_000 });
			} catch (error) {
				if (error instanceof BudgetExhaustedError) throw error;
				// 预热失败照常记录；不做断言，避免把预热抖动算进主统计。
			}
			session.recordRow({
				sampleId: `transport-warmup-${arm.name}-${randomUUID().slice(0, 8)}`,
				phase: 'transport',
				arm: `${arm.name}-warmup`,
				caseId: 'eval-arrangement-explicit',
				repeat: 0,
				commit: session.commit,
				sdkVersion: session.sdkVersion,
				modelLabel: arm.modelLabel,
				promptHash: 'warmup',
				configurationHash: `${session.commit}:${arm.name}`,
				outcome: 'warmup',
				totalMs: Date.now() - startedAt,
				queueMs: 0,
				modelAttempts: 1,
				logicalSteps: 1,
				searchRequests: 0,
				searchCacheHits: 0,
				repairCount: 0,
				firstContentMs: null,
				errorCode: null
			});
		}
	});

	for (const [pairIndex, scenarioId] of scenarioIds.entries()) {
		for (let repeat = 1; repeat <= 3; repeat += 1) {
			// 交错臂顺序：第一组 A1/A2，下一组 A2/A1，串行执行消除抢占影响。
			const orderedArms = pairIndex % 2 === 0 ? configuredArms : [...configuredArms].reverse();
			for (const arm of orderedArms) {
				it(`transport ${arm.name} ${scenarioId} repeat ${repeat}`, async (ctx) => {
					if (session.remainingModelRequests < 1) return ctx.skip();
					const { messages, promptHash } = frozenMessages(scenarioId);
					const client = arm.createClient({
						onModelRequest: () => session.reserveModelRequests(1)
					});
					expect(client).toBeTruthy();
					const startedAt = Date.now();
					let outcome = 'model_failed';
					let errorCode: string | null = null;
					const firstContentMs: number | null = null;
					try {
						const raw = await (client as ModelClient).complete(messages, { timeoutMs: 90_000 });
						try {
							parseGuidanceActionEnvelope(raw);
							outcome = 'protocol_pass';
						} catch (error) {
							outcome = 'protocol_fail';
							errorCode = error instanceof Error ? error.message.slice(0, 80) : 'parse';
						}
					} catch (error) {
						errorCode = error instanceof Error ? error.name : 'unknown';
					}
					session.recordRow({
						sampleId: `transport-${arm.name}-${scenarioId}-r${repeat}-${randomUUID().slice(0, 8)}`,
						phase: 'transport',
						arm: arm.name,
						caseId: scenarioId,
						repeat,
						commit: session.commit,
						sdkVersion: session.sdkVersion,
						modelLabel: arm.modelLabel,
						promptHash,
						configurationHash: `${session.commit}:${arm.name}`,
						outcome,
						totalMs: Date.now() - startedAt,
						queueMs: 0,
						modelAttempts: 1,
						logicalSteps: 1,
						searchRequests: 0,
						searchCacheHits: 0,
						repairCount: 0,
						firstContentMs,
						errorCode
					});
					expect(['protocol_pass', 'protocol_fail', 'model_failed']).toContain(outcome);
				});
			}
		}
	}
});

phaseSuite('policy', () => {
	const scenarioIds = latencyScenarios.map((scenario) => scenario.id);
	const session = new EvalSession({ phase: 'policy', maxModelRequests: 60 });
	const sdkArm = armsForTransportPhase().find((arm) => arm.transport === 'sdk');
	it('has the SDK arm configured', () => {
		expect(sdkArm, 'AGENT_SDK_* 评测配置缺失').toBeTruthy();
	});
	const armPolicies: Array<{ arm: ArmDefinition; policy: GuidancePolicy }> = sdkArm
		? [
				{ arm: sdkArm, policy: LEGACY_GUIDANCE_POLICY },
				{ arm: sdkArm, policy: resolveGuidancePolicy({ GUIDANCE_POLICY: 'fast' }) }
			]
		: [];

	for (const [pairIndex, scenarioId] of scenarioIds.entries()) {
		for (let repeat = 1; repeat <= 2; repeat += 1) {
			const ordered = pairIndex % 2 === 0 ? armPolicies : [...armPolicies].reverse();
			for (const entry of ordered) {
				const armName =
					entry.policy.mode === 'fast'
						? `${entry.arm.name}-fast`
						: `${entry.arm.name}-legacypolicy`;
				it(`policy ${armName} ${scenarioId} repeat ${repeat}`, async (ctx) => {
					if (!sdkArm) return ctx.skip();
					if (session.remainingModelRequests < 1) return ctx.skip();
					const outcome = await runFullGuidance({
						session,
						arm: { ...entry.arm, name: armName },
						policy: entry.policy,
						scenarioId,
						repeat,
						cache: null
					});
					if (outcome === 'budget') return ctx.skip();
					expect(['ready', 'needs_input', 'failed', 'superseded']).toContain(
						outcome.result.outcome
					);
				});
			}
		}
	}
});

phaseSuite('search', () => {
	const session = new EvalSession({ phase: 'search', maxModelRequests: 30 });
	const sdkArm = armsForTransportPhase().find((arm) => arm.transport === 'sdk');
	it('has real zhihu credentials when the search phase runs', () => {
		expect(process.env.ZHIHU_ACCESS_SECRET, 'ZHIHU_ACCESS_SECRET 缺失').toBeTruthy();
		expect(sdkArm, 'AGENT_SDK_* 评测配置缺失').toBeTruthy();
	});

	const searchScenarios = [
		// 正例：用户明确要求查知乎经验，必须出现一次真实检索尝试。
		{ scenarioId: 'eval-zhihu-experience-requested', expectSearch: true },
		// 负例：普通材料解释，非必要检索不应发生。
		{ scenarioId: 'eval-arrangement-explicit', expectSearch: false }
	] as const;

	for (const entry of searchScenarios) {
		for (let repeat = 1; repeat <= 3; repeat += 1) {
			it(`search ${entry.expectSearch ? 'required' : 'normal'} ${entry.scenarioId} repeat ${repeat}`, async (ctx) => {
				if (!sdkArm || !process.env.ZHIHU_ACCESS_SECRET) return ctx.skip();
				if (session.remainingModelRequests < 1) return ctx.skip();
				const zhihu = createZhihuClient({
					accessSecret: process.env.ZHIHU_ACCESS_SECRET as string
				});
				// 透传 SearchCallOptions：runtime 的取消/超时预算必须到达真实请求边界。
				const countedZhihu: ZhihuClient = {
					searchZhihu: async (query, count, options) => {
						session.reserveSearchRequests(1);
						return zhihu.searchZhihu(query, count, options);
					},
					searchGlobal: async (query, count, options) => {
						session.reserveSearchRequests(1);
						return zhihu.searchGlobal(query, count, options);
					}
				};
				const repository = isolatedRepository();
				const materialised = materialiseScenario(
					repository,
					latencyScenarios.find((scenario) => scenario.id === entry.scenarioId)!
				);
				const policy = resolveGuidancePolicy({ GUIDANCE_POLICY: 'fast' });
				const model = sdkArm.createClient({ onModelRequest: () => {} });
				const runtime = createEvalRuntimeDependencies({
					repository,
					model: {
						complete: (messages, callOptions) => {
							session.reserveModelRequests(1);
							return (model as ModelClient).complete(messages, {
								...callOptions,
								timeoutMs: callOptions?.timeoutMs ?? policy.modelTimeoutMs
							});
						}
					},
					policy,
					zhihu: countedZhihu
				});
				const result = await runtime.run(materialised.caseId);
				const payload = finishedPayloadFor(repository, materialised.caseId, result.runId);
				const searches = (payload.searches ?? []) as Array<Record<string, unknown>>;
				session.recordRow({
					sampleId: `search-${entry.scenarioId}-r${repeat}-${randomUUID().slice(0, 8)}`,
					phase: 'search',
					arm: 'sdk-fast-realzhihu',
					caseId: entry.scenarioId,
					repeat,
					commit: session.commit,
					sdkVersion: session.sdkVersion,
					modelLabel: sdkArm.modelLabel,
					promptHash: materialised.promptHash,
					configurationHash: `${session.commit}:sdk-fast-realzhihu`,
					outcome: result.outcome,
					totalMs: typeof payload.totalMs === 'number' ? payload.totalMs : 0,
					queueMs: typeof payload.queueMs === 'number' ? payload.queueMs : 0,
					modelAttempts: ((payload.modelCalls ?? []) as unknown[]).length,
					logicalSteps: new Set(
						((payload.modelCalls ?? []) as Array<Record<string, unknown>>).map((call) => call.index)
					).size,
					searchRequests: searches.length,
					searchCacheHits: 0,
					repairCount: typeof payload.repairCount === 'number' ? payload.repairCount : 0,
					firstContentMs: null,
					errorCode: result.error?.code ?? null
				});
				session.recordAttempts(`sdk-fast-realzhihu-${entry.scenarioId}-r${repeat}`, payload);
				session.recordOutput(
					'search',
					'sdk-fast-realzhihu',
					entry.scenarioId,
					repeat,
					result.guidance
				);
				if (entry.expectSearch) {
					// 正例契约：用户明确要求检索时必须发生一次真实搜索尝试。
					expect(searches.length).toBeGreaterThanOrEqual(1);
					// 检索失败时输出不得声称已查证（正文不含"已查证/根据检索结果确认"类断言）。
					if (searches.every((search) => search.outcome !== 'ok')) {
						const draft = (result.guidance as GuidanceSnapshot | null)?.draft;
						const serialized = draft ? JSON.stringify(draft) : '';
						expect(serialized.includes('已查证') && searches.every((s) => s.outcome !== 'ok')).toBe(
							false
						);
					}
				} else {
					expect(searches.length).toBe(0);
				}
				expect(['ready', 'needs_input', 'failed']).toContain(result.outcome);
			});
		}
	}
});

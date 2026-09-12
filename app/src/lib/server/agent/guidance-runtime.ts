import { randomUUID } from 'node:crypto';

import type { GuidanceDraft, GuidanceSnapshot, SourceRef } from '$lib/domain/guidance';
import type { ExternalClue } from '$lib/domain/types';
import { redactSearchQuery } from '$lib/privacy/redact';
import type { CaseRepository } from '$lib/server/cases/repository';
import type { ZhihuClient } from '$lib/server/zhihu/client';
import { buildGuidanceMessages, type GuidancePromptPriorGuidance } from './guidance-prompt';
import { parseGuidanceAction } from './guidance-protocol';
import type { ModelClient, ModelMessage } from './model-client';

const MAX_MODEL_CALLS = 5;
const MAX_SEARCHES = 2;
const DEFAULT_MAX_CONTEXT_CHARACTERS = 120_000;

export interface GuidanceModelCallRecord {
	index: number;
	durationMs: number;
	actionType: string | null;
	parsed: boolean;
	ok: boolean;
}

export interface GuidanceSearchRecord {
	index: number;
	type: 'search_zhihu' | 'search_global';
	durationMs: number;
	outcome: 'ok' | 'unavailable' | 'limit';
	resultCount: number;
}

export interface GuidanceRunResult {
	runId: string;
	outcome: 'ready' | 'needs_input' | 'failed' | 'superseded';
	guidance: GuidanceSnapshot | null;
	error?: { code: string; message: string };
	contextRevision: number;
	modelCallCount: number;
	searchCount: number;
	repairCount: number;
}

export interface GuidanceRuntimeDependencies {
	repository: CaseRepository;
	model: ModelClient | null;
	zhihu: ZhihuClient;
	now?: () => number;
	maxContextCharacters?: number;
}

function messageCharacters(messages: readonly ModelMessage[]): number {
	return messages.reduce((total, message) => total + message.content.length, 0);
}

function toolMessage(payload: Record<string, unknown>): ModelMessage {
	return { role: 'user', content: `工具结果：${JSON.stringify(payload)}` };
}

function guidanceReferences(draft: GuidanceDraft): SourceRef[] {
	return [
		...draft.understanding.sources,
		...draft.communicationChecks.flatMap((check) => check.sources),
		...(draft.nextStep?.contact?.sources ?? [])
	];
}

function invalidReferences(
	draft: GuidanceDraft,
	evidenceIds: ReadonlySet<string>,
	inputIds: ReadonlySet<string>,
	externalIds: ReadonlySet<string>
): SourceRef[] {
	return guidanceReferences(draft).filter((source) => {
		if (source.kind === 'evidence') return !evidenceIds.has(source.id);
		if (source.kind === 'input') return !inputIds.has(source.id);
		return !externalIds.has(source.id);
	});
}

function priorGuidance(snapshot: GuidanceSnapshot): GuidancePromptPriorGuidance {
	return {
		id: snapshot.id,
		contextRevision: snapshot.contextRevision,
		draft: snapshot.draft
	};
}

function repairMessage(
	reason: string,
	evidenceIds: ReadonlySet<string>,
	inputIds: ReadonlySet<string>,
	externalIds: ReadonlySet<string>
): ModelMessage {
	return {
		role: 'user',
		content: [
			`GUIDANCE_INVALID：${reason}`,
			`允许的 evidence IDs：${JSON.stringify([...evidenceIds])}`,
			`允许的 input IDs：${JSON.stringify([...inputIds])}`,
			`允许的 external IDs（仅限本轮搜索结果）：${JSON.stringify([...externalIds])}`,
			'请只重新输出一个合法的 search_zhihu、search_global 或 provide_guidance 动作 JSON。'
		].join('\n')
	};
}

function failure(
	runId: string,
	contextRevision: number,
	modelCallCount: number,
	searchCount: number,
	repairCount: number,
	code: string,
	message: string
): GuidanceRunResult {
	return {
		runId,
		outcome: 'failed',
		guidance: null,
		error: { code, message },
		contextRevision,
		modelCallCount,
		searchCount,
		repairCount
	};
}

export function createGuidanceRuntime(dependencies: GuidanceRuntimeDependencies) {
	const { repository, model, zhihu } = dependencies;
	const now = dependencies.now ?? (() => performance.now());
	const maxContextCharacters = dependencies.maxContextCharacters ?? DEFAULT_MAX_CONTEXT_CHARACTERS;
	interface CaseFlightState {
		activeRevision: number;
		activePromise: Promise<GuidanceRunResult>;
		queuedPromise: Promise<GuidanceRunResult> | null;
	}
	const inFlight = new Map<string, CaseFlightState>();

	async function execute(caseId: string): Promise<GuidanceRunResult> {
		const runId = randomUUID();
		const startedAt = now();
		const modelCalls: GuidanceModelCallRecord[] = [];
		const searches: GuidanceSearchRecord[] = [];
		let searchCount = 0;
		let repairCount = 0;
		let result: GuidanceRunResult | undefined;

		const caseRecord = repository.getCase(caseId);
		if (!caseRecord) throw new Error(`找不到案例：${caseId}`);
		const { contextRevision } = repository.getCaseContext(caseId);

		function finish(completed: GuidanceRunResult): GuidanceRunResult {
			result = completed;
			repository.appendEvent(caseId, {
				type: 'guidance.run.finished',
				payload: {
					runId,
					contextRevision,
					outcome: completed.outcome,
					totalMs: Math.round(now() - startedAt),
					modelCallCount: modelCalls.length,
					modelCalls,
					searchCount,
					searches,
					repairCount,
					snapshotId: completed.guidance?.id ?? null,
					failureCode: completed.error?.code ?? null
				}
			});
			return completed;
		}

		try {
			const inputs = repository.listCaseInputs(caseId);
			const guidanceHistory = repository.listGuidance(caseId);
			const latestGuidance = guidanceHistory.at(-1) ?? null;
			const referencedGuidance = [
				...new Set(
					inputs
						.map((input) => input.guidanceId)
						.filter((guidanceId): guidanceId is string => guidanceId !== null)
				)
			]
				.map((guidanceId) => repository.getGuidance(caseId, guidanceId))
				.filter((snapshot): snapshot is GuidanceSnapshot => snapshot !== null)
				.map(priorGuidance);
			const gatheredClues = new Map<string, ExternalClue>();
			const evidenceIds = new Set(caseRecord.evidence.map((evidence) => evidence.id));
			const inputIds = new Set(inputs.map((input) => input.id));
			const sourceLabels = caseRecord.evidence.map((evidence) => evidence.sourceLabel);
			const messages = buildGuidanceMessages({
				case: {
					id: caseRecord.id,
					title: caseRecord.title,
					goal: caseRecord.goal,
					confusion: caseRecord.confusion,
					contextRevision
				},
				evidence: caseRecord.evidence,
				inputs,
				externalClues: [],
				priorGuidance: latestGuidance ? priorGuidance(latestGuidance) : null,
				referencedGuidance
			});

			if (messageCharacters(messages) > maxContextCharacters) {
				return finish(
					failure(
						runId,
						contextRevision,
						modelCalls.length,
						searchCount,
						repairCount,
						'INPUT_TOO_LONG',
						'案例上下文超过本轮可处理长度，请减少单次材料后重试'
					)
				);
			}
			if (!model) {
				return finish(
					failure(
						runId,
						contextRevision,
						modelCalls.length,
						searchCount,
						repairCount,
						'MODEL_NOT_CONFIGURED',
						'尚未配置可用的指导模型'
					)
				);
			}

			for (let callIndex = 1; callIndex <= MAX_MODEL_CALLS; callIndex += 1) {
				if (messageCharacters(messages) > maxContextCharacters) {
					return finish(
						failure(
							runId,
							contextRevision,
							modelCalls.length,
							searchCount,
							repairCount,
							'INPUT_TOO_LONG',
							'本轮模型上下文超过可处理长度'
						)
					);
				}

				const callStartedAt = now();
				let rawAction: string;
				try {
					rawAction = await model.complete(messages);
				} catch {
					modelCalls.push({
						index: callIndex,
						durationMs: Math.round(now() - callStartedAt),
						actionType: null,
						parsed: false,
						ok: false
					});
					return finish(
						failure(
							runId,
							contextRevision,
							modelCalls.length,
							searchCount,
							repairCount,
							'MODEL_CALL_FAILED',
							'指导模型暂时无法完成本轮请求'
						)
					);
				}

				const callRecord: GuidanceModelCallRecord = {
					index: callIndex,
					durationMs: Math.round(now() - callStartedAt),
					actionType: null,
					parsed: false,
					ok: true
				};
				modelCalls.push(callRecord);
				let action: ReturnType<typeof parseGuidanceAction>;
				try {
					action = parseGuidanceAction(rawAction);
					callRecord.actionType = action.type;
					callRecord.parsed = true;
				} catch (error) {
					const reason = error instanceof Error ? error.message : '指导动作不符合协议';
					if (repairCount === 1) {
						return finish(
							failure(
								runId,
								contextRevision,
								modelCalls.length,
								searchCount,
								repairCount,
								'GUIDANCE_INVALID',
								'模型连续提交了无效的指导动作'
							)
						);
					}
					repairCount = 1;
					messages.push(
						repairMessage(reason, evidenceIds, inputIds, new Set(gatheredClues.keys()))
					);
					continue;
				}

				messages.push({ role: 'assistant', content: rawAction });

				if (action.type === 'search_zhihu' || action.type === 'search_global') {
					if (searchCount >= MAX_SEARCHES) {
						searches.push({
							index: searches.length + 1,
							type: action.type,
							durationMs: 0,
							outcome: 'limit',
							resultCount: 0
						});
						messages.push(
							toolMessage({
								code: 'SEARCH_LIMIT_REACHED',
								message: '本轮不再搜索，请根据现有信息给出指导或追问'
							})
						);
						continue;
					}

					searchCount += 1;
					const searchStartedAt = now();
					const query = redactSearchQuery(action.query, sourceLabels);
					try {
						const clues =
							action.type === 'search_zhihu'
								? await zhihu.searchZhihu(query, action.count)
								: await zhihu.searchGlobal(query, action.count);
						const canonicalClues: ExternalClue[] = [];
						for (const item of clues) {
							if (gatheredClues.has(item.id)) continue;
							gatheredClues.set(item.id, item);
							canonicalClues.push(item);
						}
						searches.push({
							index: searches.length + 1,
							type: action.type,
							durationMs: Math.round(now() - searchStartedAt),
							outcome: 'ok',
							resultCount: canonicalClues.length
						});
						messages.push(toolMessage({ code: 'SEARCH_RESULTS', clues: canonicalClues }));
					} catch {
						searches.push({
							index: searches.length + 1,
							type: action.type,
							durationMs: Math.round(now() - searchStartedAt),
							outcome: 'unavailable',
							resultCount: 0
						});
						messages.push(
							toolMessage({
								code: 'SEARCH_UNAVAILABLE',
								message: '外部搜索暂时不可用，请继续基于已有材料给出指导或追问'
							})
						);
					}
					continue;
				}

				const invalid = invalidReferences(
					action.guidance,
					evidenceIds,
					inputIds,
					new Set(gatheredClues.keys())
				);
				if (invalid.length > 0) {
					const reason = `以下来源引用无效、类型不匹配或不属于本案例/本轮搜索：${invalid
						.map((source) => `${source.kind}:${source.id}`)
						.join('，')}`;
					if (repairCount === 1) {
						return finish(
							failure(
								runId,
								contextRevision,
								modelCalls.length,
								searchCount,
								repairCount,
								'GUIDANCE_INVALID',
								'模型连续提交了引用无效的指导'
							)
						);
					}
					repairCount = 1;
					messages.push(
						repairMessage(reason, evidenceIds, inputIds, new Set(gatheredClues.keys()))
					);
					continue;
				}

				const saved = repository.saveGuidance(
					caseId,
					contextRevision,
					action.guidance,
					[...gatheredClues.values()],
					runId
				);
				const outcome =
					saved.status === 'superseded'
						? ('superseded' as const)
						: action.guidance.question
							? ('needs_input' as const)
							: ('ready' as const);
				return finish({
					runId,
					outcome,
					guidance: saved.snapshot,
					contextRevision,
					modelCallCount: modelCalls.length,
					searchCount,
					repairCount
				});
			}

			return finish(
				failure(
					runId,
					contextRevision,
					modelCalls.length,
					searchCount,
					repairCount,
					'MODEL_CALL_LIMIT_REACHED',
					'模型在五次调用内没有提交有效指导'
				)
			);
		} catch (error) {
			if (result) throw error;
			return finish(
				failure(
					runId,
					contextRevision,
					modelCalls.length,
					searchCount,
					repairCount,
					'GUIDANCE_RUN_FAILED',
					error instanceof Error ? error.message : '指导运行遇到未知错误'
				)
			);
		}
	}

	function clearSettledFlight(
		caseId: string,
		state: CaseFlightState,
		promise: Promise<GuidanceRunResult>
	): void {
		const clear = () => {
			if (state.activePromise === promise && state.queuedPromise === null) {
				inFlight.delete(caseId);
			}
		};
		void promise.then(clear, clear);
	}

	function startFlight(caseId: string, contextRevision: number): Promise<GuidanceRunResult> {
		const promise = execute(caseId);
		const state: CaseFlightState = {
			activeRevision: contextRevision,
			activePromise: promise,
			queuedPromise: null
		};
		inFlight.set(caseId, state);
		clearSettledFlight(caseId, state, promise);
		return promise;
	}

	function queueLatestFlight(caseId: string, state: CaseFlightState): Promise<GuidanceRunResult> {
		if (state.queuedPromise) return state.queuedPromise;
		const predecessor = state.activePromise;
		const startLatest = () => {
			state.activeRevision = repository.getCaseContext(caseId).contextRevision;
			state.activePromise = queuedPromise;
			state.queuedPromise = null;
			return execute(caseId);
		};
		const queuedPromise = predecessor.then(startLatest, startLatest);
		state.queuedPromise = queuedPromise;
		clearSettledFlight(caseId, state, queuedPromise);
		return queuedPromise;
	}

	return {
		run(caseId: string): Promise<GuidanceRunResult> {
			const requestedRevision = repository.getCaseContext(caseId).contextRevision;
			const state = inFlight.get(caseId);
			if (!state) return startFlight(caseId, requestedRevision);
			if (state.queuedPromise) return state.queuedPromise;
			if (state.activeRevision === requestedRevision) return state.activePromise;
			return queueLatestFlight(caseId, state);
		}
	};
}

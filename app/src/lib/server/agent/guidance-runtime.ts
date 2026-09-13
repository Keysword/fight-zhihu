import { randomUUID } from 'node:crypto';

import type {
	DroppedGuidanceField,
	GuidanceCompleteness,
	GuidanceDraft,
	GuidanceSnapshot,
	SourceRef
} from '$lib/domain/guidance';
import type { ExternalClue } from '$lib/domain/types';
import { redactSearchQuery } from '$lib/privacy/redact';
import type { CaseRepository } from '$lib/server/cases/repository';
import type { SearchCallOptions, ZhihuClient } from '$lib/server/zhihu/client';
import { buildGuidanceMessages, type GuidancePromptPriorGuidance } from './guidance-prompt';
import { parseGuidanceActionEnvelope, type GuidanceActionEnvelope } from './guidance-protocol';
import { canRetryFast, fastBackoffDelayMs } from './guidance-policy';
import { salvageGuidance } from './guidance-salvage';
import type { SearchCache } from './search-cache';
import {
	DEFAULT_MODEL_TIMEOUT_MS,
	ModelClientError,
	type ModelClient,
	type ModelFailureReason,
	type ModelMessage,
	type ModelObservation
} from './model-client';

const MAX_MODEL_CALLS = 5;
const MAX_SEARCHES = 2;
const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CONTEXT_CHARACTERS = 120_000;
// 单次调用可达 90 秒且最多五步推理，整轮预算要留出搜索与重试的余量，
// 同时仍小于 nginx 的 300 秒读超时。
export const DEFAULT_RUN_BUDGET_MS = 240_000;
export const DEFAULT_MAX_MODEL_RETRIES = 2;
/** 完成后进度仍可查询的保留时长，供轮询取回最终结果。 */
export const PROGRESS_RETENTION_MS = 5 * 60_000;
const RETRY_BACKOFF_MS = [500, 1_500];
const RETRY_JITTER_RATIO = 0.2;

export interface GuidanceModelCallRecord {
	index: number;
	attempt: number;
	durationMs: number;
	actionType: string | null;
	parsed: boolean;
	ok: boolean;
	retryReason: ModelFailureReason | null;
	/** 以下观测字段来自传输层；旧事件缺字段仍可读。 */
	transport?: ModelObservation['transport'];
	inputCharacters?: number;
	outputCharacters?: number;
	firstContentMs?: number | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	reasoningTokens?: number | null;
	finishReason?: string | null;
	sessionCreateMs?: number;
	sessionCleanupMs?: number;
}

export interface GuidanceSearchRecord {
	index: number;
	type: 'search_zhihu' | 'search_global';
	durationMs: number;
	outcome: 'ok' | 'unavailable' | 'limit';
	resultCount: number;
	/** 命中单案例缓存时为 true；实际请求数与逻辑搜索数据此区分。 */
	cacheHit?: boolean;
}

export type GuidancePhase = 'thinking' | 'searching' | 'repairing' | 'saving';

export interface GuidanceProgressStep {
	index: number;
	phase: GuidancePhase;
	detail: string;
	atMs: number;
}

export interface GuidanceProgress {
	runId: string;
	caseId: string;
	contextRevision: number;
	phase: GuidancePhase;
	steps: GuidanceProgressStep[];
	elapsedMs: number;
	done: boolean;
	result: GuidanceRunResult | null;
	/** 完成后可被轮询取回结果的截止时刻（epoch 毫秒）；运行中为 null。 */
	retainUntil: number | null;
	/** 本轮起点，取自注入的单调时钟，用于计算运行中的已耗时。 */
	startedAt: number;
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
	modelTimeoutMs?: number;
	runBudgetMs?: number;
	maxModelRetries?: number;
	/** 逻辑检索上限；fast 策略默认 1。 */
	maxSearches?: number;
	/** 单次搜索截止时间；整轮取消优先。 */
	searchTimeoutMs?: number;
	/** 逻辑决策步数上限；真实请求数另计。 */
	maxModelSteps?: number;
	/** 策略模式：legacy 保留原重试契约；fast 使用固定退避与严格重试判定。 */
	policyMode?: 'legacy' | 'fast';
	/** 单案例内有界短期搜索缓存；评测对照时禁用。 */
	searchCache?: SearchCache;
	sleep?: (durationMs: number) => Promise<void>;
	random?: () => number;
}

function messageCharacters(messages: readonly ModelMessage[]): number {
	return messages.reduce((total, message) => total + message.content.length, 0);
}

/** 从传输层观测中挑出写入事件记录的字段；不含 prompt、密钥或模型输出正文。 */
function observationFields(observation: ModelObservation): Partial<GuidanceModelCallRecord> {
	return {
		transport: observation.transport,
		inputCharacters: observation.inputCharacters,
		outputCharacters: observation.outputCharacters,
		firstContentMs: observation.firstContentMs,
		inputTokens: observation.inputTokens,
		outputTokens: observation.outputTokens,
		reasoningTokens: observation.reasoningTokens,
		finishReason: observation.finishReason,
		sessionCreateMs: observation.sessionCreateMs,
		sessionCleanupMs: observation.sessionCleanupMs
	};
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
	const modelTimeoutMs = dependencies.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
	const runBudgetMs = dependencies.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS;
	const maxModelRetries = dependencies.maxModelRetries ?? DEFAULT_MAX_MODEL_RETRIES;
	const maxSearches = dependencies.maxSearches ?? MAX_SEARCHES;
	const searchTimeoutMs = dependencies.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
	const maxModelSteps = dependencies.maxModelSteps ?? MAX_MODEL_CALLS;
	const policyMode = dependencies.policyMode ?? 'legacy';
	const searchCache = dependencies.searchCache ?? null;
	const sleep =
		dependencies.sleep ??
		((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
	const random = dependencies.random ?? Math.random;

	function backoffDelayMs(attempt: number): number {
		const base = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
		return Math.round(base * (1 + (random() * 2 - 1) * RETRY_JITTER_RATIO));
	}

	interface CaseFlightState {
		activeRevision: number;
		activeRunId: string;
		activePromise: Promise<GuidanceRunResult>;
		/** 更新输入替代旧运行时 abort 的控制器。 */
		activeController: AbortController | null;
		/** 单调 generation：清理所有权校验，防止旧 promise 删除新状态。 */
		activeGeneration: number;
		queuedRunId: string | null;
		queuedPromise: Promise<GuidanceRunResult> | null;
	}
	const inFlight = new Map<string, CaseFlightState>();
	let generationCounter = 0;
	const nextGeneration = () => (generationCounter += 1);
	// 单进程部署下用进程内登记表承载"运行中"的进度；完成后保留一段时间供轮询取结果。
	const progressByRun = new Map<string, GuidanceProgress>();
	const latestRunByCase = new Map<string, string>();

	function pruneProgress(): void {
		if (progressByRun.size <= 200) return;
		for (const [candidate, progress] of progressByRun) {
			if (progress.done) progressByRun.delete(candidate);
		}
	}

	async function execute(
		caseId: string,
		runId: string,
		requestedAt: number,
		supersede: AbortController
	): Promise<GuidanceRunResult> {
		const startedAt = now();
		// 排队时间单独记录：调度请求时刻与 execute 实际开始时刻之差。
		const queueMs = Math.max(0, Math.round(startedAt - requestedAt));
		// 整轮截止：一个 AbortController 同时覆盖模型、搜索与退避；
		// 预算从 execute 开始计算，排队另计并受调度任务约束。
		const deadlineController = new AbortController();
		const deadlineTimer = setTimeout(
			() => deadlineController.abort(new DOMException('整轮时间预算用尽', 'TimeoutError')),
			runBudgetMs
		);
		// 模型/搜索使用的组合信号：整轮截止或被更新输入替代都会立即中止在飞请求。
		const runSignal = AbortSignal.any([deadlineController.signal, supersede.signal]);
		const modelCalls: GuidanceModelCallRecord[] = [];
		const searches: GuidanceSearchRecord[] = [];
		// One reasoning step can span several transport attempts; the budget counts steps.
		const stepCount = () => new Set(modelCalls.map((record) => record.index)).size;
		let searchCount = 0;
		// Schema and reference repairs get separate budgets: "malformed once, then a bad
		// reference" is a common pair and must not be fatal on the first combination.
		const repairs = { schema: 0, reference: 0 };
		const repairTotal = () => repairs.schema + repairs.reference;
		let result: GuidanceRunResult | undefined;

		const caseRecord = repository.getCase(caseId);
		if (!caseRecord) throw new Error(`找不到案例：${caseId}`);
		const { contextRevision } = repository.getCaseContext(caseId);

		const progress: GuidanceProgress =
			// 排队中的运行在调度时已建立进度条目，保证 runId 立即可查询、不返回 404。
			progressByRun.get(runId) ?? {
				runId,
				caseId,
				contextRevision,
				phase: 'thinking',
				steps: [],
				elapsedMs: 0,
				done: false,
				result: null,
				retainUntil: null,
				startedAt
			};
		progress.caseId = caseId;
		progress.contextRevision = contextRevision;
		progress.startedAt = startedAt;
		progress.done = false;
		progress.result = null;
		progress.retainUntil = null;
		progressByRun.set(runId, progress);
		latestRunByCase.set(caseId, runId);
		pruneProgress();
		repository.appendEvent(caseId, {
			type: 'guidance.run.started',
			payload: { runId, contextRevision }
		});

		/** 只记录阶段与计数，不写入原始模型回复或完整提示。 */
		function recordStep(phase: GuidancePhase, detail: string): void {
			const atMs = Math.round(now() - startedAt);
			progress.phase = phase;
			progress.elapsedMs = atMs;
			const step: GuidanceProgressStep = {
				index: progress.steps.length + 1,
				phase,
				detail,
				atMs
			};
			progress.steps.push(step);
			repository.appendEvent(caseId, {
				type: 'guidance.step',
				payload: { runId, index: step.index, phase, detail }
			});
		}

		function finish(completed: GuidanceRunResult): GuidanceRunResult {
			result = completed;
			progress.done = true;
			progress.result = completed;
			progress.elapsedMs = Math.round(now() - startedAt);
			const settledAt = Date.now();
			progress.retainUntil = settledAt + PROGRESS_RETENTION_MS;
			repository.appendEvent(caseId, {
				type: 'guidance.run.finished',
				payload: {
					runId,
					contextRevision,
					outcome: completed.outcome,
					totalMs: Math.round(now() - startedAt),
					queueMs,
					requestedAt: Math.round(requestedAt),
					modelCallCount: stepCount(),
					modelCalls,
					searchCount,
					searches,
					repairCount: repairTotal(),
					repairs: { ...repairs },
					completeness: completed.guidance?.completeness ?? null,
					droppedCount: completed.guidance?.dropped.length ?? 0,
					snapshotId: completed.guidance?.id ?? null,
					failureCode: completed.error?.code ?? null
				}
			});
			return completed;
		}

		const gatheredClues = new Map<string, ExternalClue>();

		/** 复用既有 superseded outcome：新版输入已替代本轮，不虚构成功。 */
		function supersededResult(): GuidanceRunResult {
			return {
				runId,
				outcome: 'superseded',
				guidance: null,
				error: { code: 'SUPERSEDED', message: '已由更新后的整理替代' },
				contextRevision,
				modelCallCount: stepCount(),
				searchCount,
				repairCount: repairTotal()
			};
		}

		function saveAndSummarise(
			draft: GuidanceDraft,
			degradation: { completeness: GuidanceCompleteness; dropped: DroppedGuidanceField[] }
		): GuidanceRunResult {
			recordStep('saving', '正在保存这一版');
			const saved = repository.saveGuidance(
				caseId,
				contextRevision,
				draft,
				[...gatheredClues.values()],
				runId,
				degradation
			);
			const outcome =
				saved.status === 'superseded'
					? ('superseded' as const)
					: draft.question
						? ('needs_input' as const)
						: ('ready' as const);
			return {
				runId,
				outcome,
				guidance: saved.snapshot,
				contextRevision,
				modelCallCount: stepCount(),
				searchCount,
				repairCount: repairTotal()
			};
		}

		try {
			const inputs = repository.listCaseInputs(caseId);
			const guidanceHistory = repository.listGuidance(caseId, 1);
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
						stepCount(),
						searchCount,
						repairTotal(),
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
						stepCount(),
						searchCount,
						repairTotal(),
						'MODEL_NOT_CONFIGURED',
						'尚未配置可用的指导模型'
					)
				);
			}

			for (let callIndex = 1; callIndex <= maxModelSteps; callIndex += 1) {
				if (supersede.signal.aborted) {
					return finish(supersededResult());
				}
				if (messageCharacters(messages) > maxContextCharacters) {
					return finish(
						failure(
							runId,
							contextRevision,
							stepCount(),
							searchCount,
							repairTotal(),
							'INPUT_TOO_LONG',
							'本轮模型上下文超过可处理长度'
						)
					);
				}

				if (now() - startedAt >= runBudgetMs) {
					return finish(
						failure(
							runId,
							contextRevision,
							stepCount(),
							searchCount,
							repairTotal(),
							'TIME_BUDGET_EXCEEDED',
							'本轮整理超过可用时间，请稍后重试'
						)
					);
				}

				recordStep(
					'thinking',
					callIndex === 1 ? '正在理解你的材料' : `正在继续推进第 ${callIndex} 步判断`
				);

				let rawAction: string | undefined;
				let lastReason: ModelFailureReason | null = null;
				let attempted = false;
				// Retries cover transport flakiness only, so they deliberately do not consume
				// MAX_MODEL_CALLS, which budgets reasoning steps.
				for (let attempt = 1; attempt <= maxModelRetries + 1; attempt += 1) {
					const attemptStartedAt = now();
					const remainingMs = runBudgetMs - (attemptStartedAt - startedAt);
					if (remainingMs <= 0) break;
					attempted = true;
					let attemptRecord: GuidanceModelCallRecord | null = null;
					let observation: ModelObservation | null = null;
					try {
						rawAction = await model.complete(messages, {
							timeoutMs: Math.min(modelTimeoutMs, remainingMs),
							// 组合信号：整轮截止或被更新输入替代，都立即中止在飞请求。
							signal: runSignal,
							// 观测回调（含 OpenCode 后台清理的迟到观测）合并进同一条
							// attempt 记录；回调自身异常不得改写请求结果。
							onObservation: (observed) => {
								if (attemptRecord) Object.assign(attemptRecord, observationFields(observed));
								else observation = observed;
							}
						});
						attemptRecord = {
							index: callIndex,
							attempt,
							durationMs: Math.round(now() - attemptStartedAt),
							actionType: null,
							parsed: false,
							ok: true,
							retryReason: null,
							...(observation ? observationFields(observation) : {})
						};
						modelCalls.push(attemptRecord);
						break;
					} catch (error) {
						// Only failures the client itself classified are retried; an unclassified
						// error stays terminal rather than being guessed at here.
						const classified = error instanceof ModelClientError ? error : null;
						const reason: ModelFailureReason = classified?.reason ?? 'payload';
						lastReason = reason;
						attemptRecord = {
							index: callIndex,
							attempt,
							durationMs: Math.round(now() - attemptStartedAt),
							actionType: null,
							parsed: false,
							ok: false,
							retryReason: reason,
							...(observation ? observationFields(observation) : {})
						};
						modelCalls.push(attemptRecord);
						const retriesUsed = attempt - 1;
						const attemptMs = Math.round(now() - attemptStartedAt);
						// legacy 保留原重试契约（分类可重试即重试）；fast 只对快速 network/5xx 补一次。
						const shouldRetry =
							policyMode === 'fast'
								? canRetryFast(error, attemptMs, remainingMs, retriesUsed, maxModelRetries)
								: Boolean(classified?.retryable) && retriesUsed < maxModelRetries;
						if (!shouldRetry) break;
						const delayMs =
							policyMode === 'fast'
								? fastBackoffDelayMs(runBudgetMs - (now() - startedAt))
								: backoffDelayMs(attempt);
						if (delayMs === null) break;
						if (now() - startedAt + delayMs >= runBudgetMs) break;
						await sleep(delayMs);
					}
				}

				// 整轮截止或被替代后（含模型无视取消信号而迟到返回的正文）一律丢弃。
				if (runSignal.aborted) rawAction = undefined;

				if (rawAction === undefined) {
					if (supersede.signal.aborted) {
						return finish(supersededResult());
					}
					const budgetExhausted =
						!attempted ||
						deadlineController.signal.aborted ||
						(lastReason === 'timeout' && now() - startedAt >= runBudgetMs);
					return finish(
						failure(
							runId,
							contextRevision,
							stepCount(),
							searchCount,
							repairTotal(),
							budgetExhausted ? 'TIME_BUDGET_EXCEEDED' : 'MODEL_CALL_FAILED',
							'指导模型暂时无法完成本轮请求'
						)
					);
				}

				const callRecord = modelCalls.at(-1) as GuidanceModelCallRecord;
				let envelope: GuidanceActionEnvelope;
				try {
					envelope = parseGuidanceActionEnvelope(rawAction);
				} catch (error) {
					const reason = error instanceof Error ? error.message : '指导动作不符合协议';
					if (repairs.schema >= 1) {
						return finish(
							failure(
								runId,
								contextRevision,
								stepCount(),
								searchCount,
								repairTotal(),
								'GUIDANCE_INVALID',
								'模型连续提交了无效的指导动作'
							)
						);
					}
					recordStep('repairing', '正在重新整理');
					repairs.schema += 1;
					messages.push(
						repairMessage(reason, evidenceIds, inputIds, new Set(gatheredClues.keys()))
					);
					continue;
				}

				if (envelope.kind === 'salvageable') {
					callRecord.actionType = 'provide_guidance';
					messages.push({ role: 'assistant', content: rawAction });
					// One strict-schema repair is still offered before falling back to salvage, so a
					// model that can simply restate a compliant reply is given that chance first.
					// fast 模式下剩余时间不足以再发起一次模型请求时，优先 salvage 可用草稿。
					const remainingForRepairMs = runBudgetMs - (now() - startedAt);
					const repairAffordable =
						repairs.schema < 1 &&
						!(policyMode === 'fast' && remainingForRepairMs < 10_000);
					if (repairAffordable) {
						recordStep('repairing', '正在重新整理');
						repairs.schema += 1;
						messages.push(
							repairMessage(envelope.reason, evidenceIds, inputIds, new Set(gatheredClues.keys()))
						);
						continue;
					}
					const salvaged = salvageGuidance(envelope.raw, {
						evidence: evidenceIds,
						input: inputIds,
						external: new Set(gatheredClues.keys())
					});
					if (!salvaged.draft) {
						return finish(
							failure(
								runId,
								contextRevision,
								stepCount(),
								searchCount,
								repairTotal(),
								'GUIDANCE_INVALID',
								'模型连续提交了无效的指导动作'
							)
						);
					}
					return finish(saveAndSummarise(salvaged.draft, salvaged));
				}

				const action = envelope.action;
				callRecord.actionType = action.type;
				callRecord.parsed = true;

				messages.push({ role: 'assistant', content: rawAction });

				if (action.type === 'search_zhihu' || action.type === 'search_global') {
					if (searchCount >= maxSearches) {
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

					recordStep('searching', '正在检索相似经验');
					searchCount += 1;
					const searchStartedAt = now();
					const query = redactSearchQuery(action.query, sourceLabels);
					// 缓存 key 使用脱敏后的检索词与来源/条数；按案例隔离。
					const cacheKey = {
						source: action.type === 'search_zhihu' ? ('zhihu' as const) : ('global' as const),
						query,
						count: Math.max(1, Math.trunc(action.count))
					};
					const searchOptions: SearchCallOptions = {
						// 整轮取消或被替代立即停止；搜索自身超时按不可用继续本轮。
						signal: runSignal,
						timeoutMs: searchTimeoutMs
					};
					const cachedClues = searchCache?.get(caseId, cacheKey, Date.now()) ?? null;
					if (cachedClues) {
						const canonicalClues: ExternalClue[] = [];
						for (const item of cachedClues) {
							if (gatheredClues.has(item.id)) continue;
							gatheredClues.set(item.id, item);
							canonicalClues.push(item);
						}
						searches.push({
							index: searches.length + 1,
							type: action.type,
							durationMs: Math.round(now() - searchStartedAt),
							outcome: 'ok',
							resultCount: canonicalClues.length,
							cacheHit: true
						});
						messages.push(toolMessage({ code: 'SEARCH_RESULTS', clues: canonicalClues }));
						continue;
					}
					try {
						const clues =
							action.type === 'search_zhihu'
								? await zhihu.searchZhihu(query, action.count, searchOptions)
								: await zhihu.searchGlobal(query, action.count, searchOptions);
						// 只有成功结果进入缓存；失败/超时不缓存，本轮内仍然可用。
						searchCache?.set(caseId, cacheKey, clues, Date.now());
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
							resultCount: canonicalClues.length,
							cacheHit: false
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
					// One reference repair is offered on its own budget; after that the illegal ids are
					// stripped rather than used to discard an otherwise usable reply.
					if (repairs.reference < 1) {
						recordStep('repairing', '正在核对引用的材料');
						repairs.reference += 1;
						messages.push(
							repairMessage(reason, evidenceIds, inputIds, new Set(gatheredClues.keys()))
						);
						continue;
					}
					const salvaged = salvageGuidance(action.guidance, {
						evidence: evidenceIds,
						input: inputIds,
						external: new Set(gatheredClues.keys())
					});
					if (!salvaged.draft) {
						return finish(
							failure(
								runId,
								contextRevision,
								stepCount(),
								searchCount,
								repairTotal(),
								'GUIDANCE_INVALID',
								'模型连续提交了引用无效的指导'
							)
						);
					}
					return finish(saveAndSummarise(salvaged.draft, salvaged));
				}

				return finish(saveAndSummarise(action.guidance, { completeness: 'full', dropped: [] }));
			}

			return finish(
				failure(
					runId,
					contextRevision,
					stepCount(),
					searchCount,
					repairTotal(),
					'MODEL_CALL_LIMIT_REACHED',
					`模型在 ${maxModelSteps} 步内没有提交有效指导`
				)
			);
		} catch (error) {
			if (result) throw error;
			return finish(
				failure(
					runId,
					contextRevision,
					stepCount(),
					searchCount,
					repairTotal(),
					'GUIDANCE_RUN_FAILED',
					error instanceof Error ? error.message : '指导运行遇到未知错误'
				)
			);
		} finally {
			// 预算截止定时器只在 finally 清除；迟到的模型结果不会再被任何分支消费。
			clearTimeout(deadlineTimer);
		}
	}

	function clearSettledFlight(
		caseId: string,
		state: CaseFlightState,
		promise: Promise<GuidanceRunResult>,
		generation: number
	): void {
		const clear = () => {
			// 以单调 generation 校验所有权：旧 promise 的 finally 不得删除新一轮的状态。
			if (
				state.activeGeneration === generation &&
				state.activePromise === promise &&
				state.queuedPromise === null
			) {
				inFlight.delete(caseId);
			}
		};
		void promise.then(clear, clear);
	}

	function startFlight(
		caseId: string,
		contextRevision: number,
		runId: string,
		requestedAt: number
	): Promise<GuidanceRunResult> {
		const controller = new AbortController();
		const promise = execute(caseId, runId, requestedAt, controller);
		const state: CaseFlightState = {
			activeRevision: contextRevision,
			activeRunId: runId,
			activePromise: promise,
			activeController: controller,
			activeGeneration: nextGeneration(),
			queuedRunId: null,
			queuedPromise: null
		};
		inFlight.set(caseId, state);
		clearSettledFlight(caseId, state, promise, state.activeGeneration);
		return promise;
	}

	function queueLatestFlight(
		caseId: string,
		state: CaseFlightState,
		runId: string,
		requestedAt: number
	): Promise<GuidanceRunResult> {
		if (state.queuedPromise) return state.queuedPromise;
		const predecessor = state.activePromise;
		const generation = nextGeneration();
		const queuedController = new AbortController();
		// 排队中的运行也先建立进度条目：runId 返回后立即可查询，不会 404。
		progressByRun.set(runId, {
			runId,
			caseId,
			contextRevision: repository.getCaseContext(caseId).contextRevision,
			phase: 'thinking',
			steps: [
				{
					index: 1,
					phase: 'thinking',
					detail: '已排队：等待上一轮整理结束后立即开始',
					atMs: 0
				}
			],
			elapsedMs: 0,
			done: false,
			result: null,
			retainUntil: null,
			startedAt: now()
		});
		const startLatest = () => {
			state.activeRevision = repository.getCaseContext(caseId).contextRevision;
			state.activeRunId = runId;
			state.activePromise = queuedPromise;
			state.activeController = queuedController;
			state.activeGeneration = generation;
			state.queuedRunId = null;
			state.queuedPromise = null;
			return execute(caseId, runId, requestedAt, queuedController);
		};
		const queuedPromise = predecessor.then(startLatest, startLatest);
		state.queuedPromise = queuedPromise;
		clearSettledFlight(caseId, state, queuedPromise, generation);
		return queuedPromise;
	}

	/**
	 * 单案例串行调度。返回 runId 供轮询定位本轮进度：
	 * 复用在飞运行时返回既有 runId，排队时返回将要执行那一轮的 runId。
	 * 更新后的 contextRevision 会取消旧运行（本地结算后启动新运行，不等待远端清理）。
	 */
	function schedule(caseId: string): { runId: string; promise: Promise<GuidanceRunResult> } {
		const requestedAt = now();
		const requestedRevision = repository.getCaseContext(caseId).contextRevision;
		const state = inFlight.get(caseId);
		if (!state) {
			const runId = randomUUID();
			return { runId, promise: startFlight(caseId, requestedRevision, runId, requestedAt) };
		}
		if (state.queuedPromise) {
			return { runId: state.queuedRunId ?? randomUUID(), promise: state.queuedPromise };
		}
		if (state.activeRevision === requestedRevision) {
			return { runId: state.activeRunId, promise: state.activePromise };
		}
		// 新版输入到达：取消旧 controller；旧运行在本地完成终态结算（写 superseded 事件）
		// 后新运行立即启动，不等待长时间远端 session 清理。
		state.activeController?.abort(new DOMException('已由更新后的整理替代', 'AbortError'));
		const runId = randomUUID();
		state.queuedRunId = runId;
		return { runId, promise: queueLatestFlight(caseId, state, runId, requestedAt) };
	}

	function run(caseId: string): Promise<GuidanceRunResult> {
		return schedule(caseId).promise;
	}

	return {
		run,

		/**
		 * 启动一轮但不等待完成，立即返回可轮询的 runId。
		 * 同一 contextRevision 已有在飞运行时复用它，不额外起新一轮。
		 */
		start(caseId: string): { runId: string; reused: boolean } {
			const before = inFlight.get(caseId);
			const requestedRevision = repository.getCaseContext(caseId).contextRevision;
			const reused = Boolean(before && before.activeRevision === requestedRevision);
			const { runId, promise } = schedule(caseId);
			// 后台推进；结果由轮询接口取回，这里只避免未处理的 promise 拒绝。
			void promise.catch(() => {});
			return { runId, reused };
		},

		progress(caseId: string, runId: string): GuidanceProgress | null {
			const found = progressByRun.get(runId);
			if (!found || found.caseId !== caseId) return null;
			if (found.retainUntil !== null && Date.now() > found.retainUntil) {
				progressByRun.delete(runId);
				return null;
			}
			if (!found.done) found.elapsedMs = Math.round(now() - found.startedAt);
			return found;
		},

		/**
		 * 查看当前 contextRevision 上是否已有在飞运行，不产生副作用。
		 * 调用方据此决定"复用既有运行"还是"计一次限流后再启动新的一轮"。
		 */
		activeRun(caseId: string): { runId: string } | null {
			const state = inFlight.get(caseId);
			if (!state) return null;
			const requestedRevision = repository.getCaseContext(caseId).contextRevision;
			if (state.activeRevision !== requestedRevision) return null;
			const progress = progressByRun.get(state.activeRunId);
			if (!progress || progress.done) return null;
			return { runId: state.activeRunId };
		},

		latestRunId(caseId: string): string | null {
			return latestRunByCase.get(caseId) ?? null;
		}
	};
}

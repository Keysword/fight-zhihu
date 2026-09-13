import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GuidanceDraft, SourceRef } from '$lib/domain/guidance';
import type { ExternalClue } from '$lib/domain/types';
import { createCaseRepository, type CaseRepository } from '$lib/server/cases/repository';
import { ModelClientError, type ModelClient, type ModelMessage } from './model-client';
import { createGuidanceRuntime } from './guidance-runtime';

function timeoutError(): ModelClientError {
	return new ModelClientError('Agent 模型响应超时', { reason: 'timeout' });
}

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function repository(): CaseRepository {
	const directory = mkdtempSync(join(tmpdir(), 'guidance-runtime-'));
	directories.push(directory);
	return createCaseRepository(join(directory, 'cases.sqlite'));
}

function createCase(repo: CaseRepository, title = '宿舍入住') {
	return repo.createCase({
		title,
		goal: '确认明天能否入住',
		confusion: '申请和实际安排是否是同一件事？'
	});
}

function draft({
	sources = [],
	question = null,
	contactSources,
	communicationSources,
	summary = '目前只知道申请已被转达，实际安排仍需确认。'
}: {
	sources?: SourceRef[];
	question?: string | null;
	contactSources?: SourceRef[];
	communicationSources?: SourceRef[];
	summary?: string;
} = {}): GuidanceDraft {
	return {
		understanding: { summary, openPoint: '房间和时间尚不清楚。', sources },
		communicationChecks:
			communicationSources === undefined
				? []
				: [
						{
							observation: '材料只提到了申请。',
							possibleMisreading: '这可能被理解为已经安排完成。',
							whyItMatters: '会影响明天的住宿准备。',
							howToCheck: '核对房间号和领钥匙时间。',
							sources: communicationSources
						}
					],
		nextStep:
			contactSources === undefined
				? null
				: {
						kind: 'contact',
						instruction: '请已有对接人提供确认入口。',
						why: '先确认实际安排。',
						contact: { label: '住宿经办入口', basis: 'case_material', sources: contactSources },
						message: '请问是否已有房间号和领钥匙时间？',
						branches: []
					},
		question,
		changeSummary: null
	};
}

function provide(guidance: GuidanceDraft): string {
	return JSON.stringify({ type: 'provide_guidance', guidance });
}

function scriptedModel(
	responses: Array<string | Error>
): ModelClient & { calls: ModelMessage[][] } {
	const calls: ModelMessage[][] = [];
	let index = 0;
	return {
		calls,
		async complete(messages) {
			calls.push(structuredClone(messages));
			const response = responses[Math.min(index++, responses.length - 1)];
			if (response instanceof Error) throw response;
			return response;
		}
	};
}

function clue(id: string, source: 'zhihu' | 'global' = 'zhihu'): ExternalClue {
	return {
		id,
		title: '相似经验',
		excerpt: '可分别确认申请和实际安排。',
		url: `https://example.com/${id}`,
		author: '外部作者',
		editedAt: null,
		authorityLevel: null,
		source,
		relevance: '补充核实方向',
		warning: '外部经验不是本案例事实'
	};
}

function zhihuClient(results: ExternalClue[] = []) {
	return {
		searchZhihu: vi.fn(async () => results),
		searchGlobal: vi.fn(async () => results)
	};
}

function finishedEvents(repo: CaseRepository, caseId: string) {
	return repo.listEvents(caseId).filter((event) => event.type === 'guidance.run.finished');
}

describe('guidance runtime', () => {
	it('persists direct guidance after exactly one model call and accepts a non-verbatim summary', async () => {
		const repo = repository();
		const created = createCase(repo);
		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '对接人说“我帮你申请”。',
			sourceLabel: '招聘同事',
			occurredAt: null
		});
		const guidance = draft({
			sources: [{ kind: 'evidence', id: evidence.id }],
			summary: '这段材料没有提供可直接入住的确认。'
		});
		const model = scriptedModel([provide(guidance)]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient()
		}).run(created.id);

		expect(result).toMatchObject({ outcome: 'ready', modelCallCount: 1, searchCount: 0 });
		expect(result.guidance?.draft).toEqual(guidance);
		expect(repo.getCurrentGuidance(created.id)).toEqual(result.guidance);
		expect(model.calls).toHaveLength(1);
		expect(finishedEvents(repo, created.id)).toHaveLength(1);
	});

	it('persists question-only guidance and returns needs_input', async () => {
		const repo = repository();
		const created = createCase(repo);
		const guidance = draft({ question: '你收到过房间号或领钥匙时间吗？' });
		const result = await createGuidanceRuntime({
			repository: repo,
			model: scriptedModel([provide(guidance)]),
			zhihu: zhihuClient()
		}).run(created.id);

		expect(result.outcome).toBe('needs_input');
		expect(repo.getCurrentGuidance(created.id)?.draft.question).toBe(guidance.question);
	});

	it('executes two searches, feeds back the third limit, deduplicates clues, then saves guidance', async () => {
		const repo = repository();
		const created = createCase(repo);
		const first = clue('same-id');
		const second = clue('second-id', 'global');
		const zhihu = {
			searchZhihu: vi.fn(async (query: string, count?: number) => {
				void query;
				void count;
				return [first];
			}),
			searchGlobal: vi.fn(async (query: string, count?: number) => {
				void query;
				void count;
				return [first, second];
			})
		};
		const guidance = draft({ sources: [{ kind: 'external', id: second.id }] });
		const model = scriptedModel([
			JSON.stringify({ type: 'search_zhihu', query: '张老师 13800138000 新人住宿', count: 3 }),
			JSON.stringify({ type: 'search_global', query: '某某大学 入职住宿', count: 5 }),
			JSON.stringify({ type: 'search_global', query: '继续搜索', count: 2 }),
			provide(guidance)
		]);

		const result = await createGuidanceRuntime({ repository: repo, model, zhihu }).run(created.id);

		expect(result).toMatchObject({ outcome: 'ready', modelCallCount: 4, searchCount: 2 });
		expect(zhihu.searchZhihu).toHaveBeenCalledTimes(1);
		expect(zhihu.searchGlobal).toHaveBeenCalledTimes(1);
		expect(zhihu.searchZhihu.mock.calls[0]?.[0]).not.toContain('13800138000');
		expect(model.calls[3]?.at(-1)?.content).toContain('SEARCH_LIMIT_REACHED');
		expect(result.guidance?.externalClues.map((item) => item.id)).toEqual(['same-id', 'second-id']);
	});

	it('feeds the model the same canonical clue payload that it later persists', async () => {
		const repo = repository();
		const created = createCase(repo);
		const first = { ...clue('shared-id'), excerpt: 'FIRST_CANONICAL_EXCERPT' };
		const conflictingDuplicate = {
			...clue('shared-id', 'global'),
			excerpt: 'SECOND_CONFLICTING_EXCERPT'
		};
		const zhihu = {
			searchZhihu: vi.fn(async () => [first]),
			searchGlobal: vi.fn(async () => [conflictingDuplicate])
		};
		const model = scriptedModel([
			JSON.stringify({ type: 'search_zhihu', query: '住宿', count: 1 }),
			JSON.stringify({ type: 'search_global', query: '住宿', count: 1 }),
			provide(draft({ sources: [{ kind: 'external', id: first.id }] }))
		]);

		const result = await createGuidanceRuntime({ repository: repo, model, zhihu }).run(created.id);

		const finalModelContext = model.calls[2]?.map((message) => message.content).join('\n') ?? '';
		expect(finalModelContext).toContain('FIRST_CANONICAL_EXCERPT');
		expect(finalModelContext).not.toContain('SECOND_CONFLICTING_EXCERPT');
		expect(result.guidance?.externalClues).toEqual([first]);
		expect(finishedEvents(repo, created.id)[0]?.payload.searches).toEqual([
			expect.objectContaining({ outcome: 'ok', resultCount: 1 }),
			expect.objectContaining({ outcome: 'ok', resultCount: 0 })
		]);
	});

	it('continues after search errors including rate limits', async () => {
		const repo = repository();
		const created = createCase(repo);
		const zhihu = {
			searchZhihu: vi.fn(async () => {
				throw new Error('HTTP 429 secret upstream body');
			}),
			searchGlobal: vi.fn(async () => [])
		};
		const model = scriptedModel([
			JSON.stringify({ type: 'search_zhihu', query: '住宿', count: 3 }),
			provide(draft())
		]);

		const result = await createGuidanceRuntime({ repository: repo, model, zhihu }).run(created.id);

		expect(result.outcome).toBe('ready');
		expect(result.searchCount).toBe(1);
		expect(model.calls[1]?.at(-1)?.content).toContain('SEARCH_UNAVAILABLE');
	});

	it('repairs one malformed response and then accepts valid guidance', async () => {
		const repo = repository();
		const created = createCase(repo);
		const model = scriptedModel(['not json', provide(draft())]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient()
		}).run(created.id);

		expect(result).toMatchObject({ outcome: 'ready', modelCallCount: 2, repairCount: 1 });
		expect(model.calls[1]?.at(-1)?.content).toContain('允许的 evidence IDs');
	});

	it('repairs one invalid source reference and then accepts valid guidance', async () => {
		const repo = repository();
		const created = createCase(repo);
		const model = scriptedModel([
			provide(draft({ sources: [{ kind: 'evidence', id: 'missing' }] })),
			provide(draft())
		]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient()
		}).run(created.id);

		expect(result).toMatchObject({ outcome: 'ready', modelCallCount: 2, repairCount: 1 });
		expect(model.calls[1]?.at(-1)?.content).toContain('missing');
	});

	it('gives schema and reference each one repair before salvaging or giving up', async () => {
		const repo = repository();
		const created = createCase(repo);
		const model = scriptedModel([
			'{"type":"provide_guidance"}',
			provide(draft({ sources: [{ kind: 'evidence', id: 'missing' }] })),
			provide(draft())
		]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient()
		}).run(created.id);

		expect(result).toMatchObject({ outcome: 'ready', modelCallCount: 3, repairCount: 2 });
		expect(model.calls).toHaveLength(3);
	});

	it('rejects cross-case, wrong-kind, and prior-run external references before saving', async () => {
		for (const scenario of [
			'cross-evidence',
			'cross-input',
			'wrong-kind',
			'old-external'
		] as const) {
			const repo = repository();
			const currentCase = createCase(repo, `当前事项-${scenario}`);
			const otherCase = createCase(repo, `其他事项-${scenario}`);
			const ownEvidence = repo.appendEvidence(currentCase.id, {
				kind: 'message',
				content: '当前案例材料',
				sourceLabel: '当前材料',
				occurredAt: null
			});
			const otherEvidence = repo.appendEvidence(otherCase.id, {
				kind: 'message',
				content: '其他案例材料',
				sourceLabel: '其他材料',
				occurredAt: null
			});
			const otherInput = repo.appendCaseInput(otherCase.id, {
				kind: 'context',
				content: '其他案例输入',
				guidanceId: null,
				requestId: crypto.randomUUID()
			}).input;
			const oldClue = clue(`old-${scenario}`);
			repo.saveGuidance(currentCase.id, 1, draft(), [oldClue], crypto.randomUUID());

			const badSource: SourceRef =
				scenario === 'cross-evidence'
					? { kind: 'evidence', id: otherEvidence.id }
					: scenario === 'cross-input'
						? { kind: 'input', id: otherInput.id }
						: scenario === 'wrong-kind'
							? { kind: 'input', id: ownEvidence.id }
							: { kind: 'external', id: oldClue.id };
			const model = scriptedModel([provide(draft({ sources: [badSource] })), provide(draft())]);

			const result = await createGuidanceRuntime({
				repository: repo,
				model,
				zhihu: zhihuClient()
			}).run(currentCase.id);

			expect(result).toMatchObject({ outcome: 'ready', repairCount: 1 });
			expect(repo.listGuidance(currentCase.id)).toHaveLength(2);
			repo.close();
		}
	});

	it('validates references in communication checks and next-step contacts', async () => {
		const repo = repository();
		const created = createCase(repo);
		const invalid = draft({
			communicationSources: [{ kind: 'evidence', id: 'missing-check' }],
			contactSources: [{ kind: 'input', id: 'missing-contact' }]
		});
		const model = scriptedModel([provide(invalid), provide(draft())]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient()
		}).run(created.id);

		expect(result).toMatchObject({ outcome: 'ready', repairCount: 1 });
		expect(model.calls[1]?.at(-1)?.content).toContain('missing-check');
		expect(model.calls[1]?.at(-1)?.content).toContain('missing-contact');
	});

	it('stops after exactly five model calls without guidance', async () => {
		const repo = repository();
		const created = createCase(repo);
		const search = JSON.stringify({ type: 'search_global', query: '住宿流程', count: 1 });
		const model = scriptedModel([search]);
		const zhihu = zhihuClient([]);

		const result = await createGuidanceRuntime({ repository: repo, model, zhihu }).run(created.id);

		expect(result).toMatchObject({
			outcome: 'failed',
			error: { code: 'MODEL_CALL_LIMIT_REACHED' },
			modelCallCount: 5,
			searchCount: 2
		});
		expect(model.calls).toHaveLength(5);
		expect(zhihu.searchGlobal).toHaveBeenCalledTimes(2);
	});

	it('single-flights one case, runs different cases concurrently, and clears failures for retry', async () => {
		const repo = repository();
		const firstCase = createCase(repo, '事项 A');
		const secondCase = createCase(repo, '事项 B');
		const releases: Array<() => void> = [];
		const model: ModelClient = {
			complete: vi.fn(
				() =>
					new Promise<string>((resolve) => {
						releases.push(() => resolve(provide(draft())));
					})
			)
		};
		const runtime = createGuidanceRuntime({ repository: repo, model, zhihu: zhihuClient() });

		const first = runtime.run(firstCase.id);
		const duplicate = runtime.run(firstCase.id);
		const other = runtime.run(secondCase.id);
		expect(duplicate).toBe(first);
		expect(model.complete).toHaveBeenCalledTimes(2);
		releases.splice(0).forEach((release) => release());
		await Promise.all([first, duplicate, other]);

		const failedModel = scriptedModel([new Error('temporary upstream failure'), provide(draft())]);
		const retryRuntime = createGuidanceRuntime({
			repository: repo,
			model: failedModel,
			zhihu: zhihuClient()
		});
		const failed = await retryRuntime.run(firstCase.id);
		const retried = await retryRuntime.run(firstCase.id);
		expect(failed).toMatchObject({ outcome: 'failed', error: { code: 'MODEL_CALL_FAILED' } });
		expect(retried.outcome).toBe('ready');
		expect(failedModel.calls).toHaveLength(2);
	});

	it('queues one latest-revision run when feedback arrives during an active run', async () => {
		const repo = repository();
		const created = createCase(repo);
		const releases: Array<(value: string) => void> = [];
		const model: ModelClient & { calls: ModelMessage[][] } = {
			calls: [],
			complete(messages) {
				this.calls.push(structuredClone(messages));
				return new Promise<string>((resolve) => releases.push(resolve));
			}
		};
		const runtime = createGuidanceRuntime({ repository: repo, model, zhihu: zhihuClient() });

		const oldRun = runtime.run(created.id);
		expect(model.calls).toHaveLength(1);
		repo.appendCaseInput(created.id, {
			kind: 'correction',
			content: '物业已经联系不上，请换一个方向。',
			guidanceId: null,
			requestId: crypto.randomUUID()
		});
		const latestRun = runtime.run(created.id);

		expect(latestRun).not.toBe(oldRun);
		expect(model.calls).toHaveLength(1);
		releases.shift()?.(provide(draft({ summary: '旧版本理解' })));
		await expect(oldRun).resolves.toMatchObject({ outcome: 'superseded', contextRevision: 0 });
		await vi.waitFor(() => expect(model.calls).toHaveLength(2));
		expect(model.calls[1]?.map((message) => message.content).join('\n')).toContain(
			'物业已经联系不上'
		);
		releases.shift()?.(provide(draft({ summary: '已经根据新限制调整方向' })));

		await expect(latestRun).resolves.toMatchObject({
			outcome: 'ready',
			contextRevision: 1,
			guidance: { draft: { understanding: { summary: '已经根据新限制调整方向' } } }
		});
		expect(repo.getCurrentGuidance(created.id)?.contextRevision).toBe(1);
		expect(finishedEvents(repo, created.id)).toHaveLength(2);
	});

	it('returns superseded when input, evidence, or first confirmation changes during the model call', async () => {
		for (const mutation of ['input', 'evidence', 'confirmation'] as const) {
			const repo = repository();
			const created = createCase(repo, mutation);
			const evidence = repo.appendEvidence(created.id, {
				kind: 'message',
				content: '尚未确认的回复',
				sourceLabel: '对接人',
				occurredAt: null
			});
			let release!: (value: string) => void;
			const model: ModelClient = {
				complete: () => new Promise<string>((resolve) => (release = resolve))
			};
			const pending = createGuidanceRuntime({
				repository: repo,
				model,
				zhihu: zhihuClient()
			}).run(created.id);

			if (mutation === 'input') {
				repo.appendCaseInput(created.id, {
					kind: 'correction',
					content: '这条回复已经过时',
					guidanceId: null,
					requestId: crypto.randomUUID()
				});
			} else if (mutation === 'evidence') {
				repo.appendEvidence(created.id, {
					kind: 'note',
					content: '新材料',
					sourceLabel: '用户补充',
					occurredAt: null
				});
			} else {
				repo.confirmEvidence(created.id, evidence.id);
			}
			release(provide(draft()));
			const result = await pending;

			expect(result.outcome).toBe('superseded');
			expect(result.guidance).not.toBeNull();
			expect(repo.getCurrentGuidance(created.id)).toBeNull();
			expect(finishedEvents(repo, created.id)).toHaveLength(1);
			repo.close();
		}
	});

	it('never places old boards or events in the model prompt', async () => {
		const repo = repository();
		const created = createCase(repo, 'PROMPT_CASE');
		repo.saveBoard(created.id, 0, {
			caseId: created.id,
			title: 'OLD_BOARD_SENTINEL',
			goal: 'OLD_BOARD_GOAL_SENTINEL',
			stage: 'collecting',
			currentBlocker: 'OLD_BOARD_BLOCKER_SENTINEL',
			claims: [],
			participants: [],
			keyCompleter: null,
			nextAction: null,
			externalClues: [],
			updatedAt: new Date().toISOString()
		});
		repo.appendEvent(created.id, {
			type: 'agent.finished',
			payload: { content: 'OLD_EVENT_SENTINEL' }
		});
		const model = scriptedModel([provide(draft())]);

		await createGuidanceRuntime({ repository: repo, model, zhihu: zhihuClient() }).run(created.id);

		const prompt = model.calls
			.flat()
			.map((message) => message.content)
			.join('\n');
		expect(prompt).not.toContain('OLD_BOARD_SENTINEL');
		expect(prompt).not.toContain('OLD_BOARD_GOAL_SENTINEL');
		expect(prompt).not.toContain('OLD_BOARD_BLOCKER_SENTINEL');
		expect(prompt).not.toContain('OLD_EVENT_SENTINEL');
	});

	it('fails before any model call when the full prompt is too long and preserves all input', async () => {
		const repo = repository();
		const created = createCase(repo);
		for (let index = 0; index < 3; index += 1) {
			repo.appendCaseInput(created.id, {
				kind: 'context',
				content: `EARLY_INPUT_${index}_${'x'.repeat(100)}`,
				guidanceId: null,
				requestId: crypto.randomUUID()
			});
		}
		const model = scriptedModel([provide(draft())]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient(),
			maxContextCharacters: 100
		}).run(created.id);

		expect(result).toMatchObject({
			outcome: 'failed',
			error: { code: 'INPUT_TOO_LONG' },
			modelCallCount: 0
		});
		expect(model.calls).toHaveLength(0);
		expect(repo.listCaseInputs(created.id).map((input) => input.content)).toEqual([
			expect.stringContaining('EARLY_INPUT_0'),
			expect.stringContaining('EARLY_INPUT_1'),
			expect.stringContaining('EARLY_INPUT_2')
		]);
	});

	it('returns MODEL_NOT_CONFIGURED and records one content-free finished event for every outcome', async () => {
		const repo = repository();
		const noModelCase = createCase(repo, '无模型');
		const noModel = await createGuidanceRuntime({
			repository: repo,
			model: null,
			zhihu: zhihuClient()
		}).run(noModelCase.id);
		expect(noModel).toMatchObject({
			outcome: 'failed',
			error: { code: 'MODEL_NOT_CONFIGURED' },
			modelCallCount: 0
		});

		const events = finishedEvents(repo, noModelCase.id);
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({
			runId: noModel.runId,
			contextRevision: 0,
			outcome: 'failed',
			modelCallCount: 0,
			searchCount: 0,
			repairCount: 0,
			snapshotId: null,
			failureCode: 'MODEL_NOT_CONFIGURED'
		});
		expect(events[0]?.payload).toHaveProperty('totalMs');
		expect(events[0]?.payload).toHaveProperty('modelCalls');
		expect(events[0]?.payload).toHaveProperty('searches');
		expect(JSON.stringify(events[0]?.payload)).not.toMatch(
			/prompt|raw|evidence|input|clue|无模型|尚未配置可用的 Agent 模型/i
		);
	});

	it('retries a timed-out call, succeeds, and charges the step budget only once', async () => {
		const repo = repository();
		const created = createCase(repo);
		const model = scriptedModel([timeoutError(), provide(draft())]);
		const sleeps: number[] = [];

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient(),
			sleep: async (durationMs) => void sleeps.push(durationMs),
			random: () => 0.5
		}).run(created.id);

		expect(result).toMatchObject({ outcome: 'ready', modelCallCount: 1 });
		expect(model.calls).toHaveLength(2);
		expect(sleeps).toEqual([500]);
		const records = finishedEvents(repo, created.id)[0]?.payload
			.modelCalls as Array<Record<string, unknown>>;
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({ index: 1, attempt: 1, ok: false, retryReason: 'timeout' });
		expect(records[1]).toMatchObject({ index: 1, attempt: 2, ok: true, retryReason: null });
	});

	it('gives up as MODEL_CALL_FAILED after the retry budget without spending extra reasoning steps', async () => {
		const repo = repository();
		const created = createCase(repo);
		const model = scriptedModel([timeoutError()]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient(),
			sleep: async () => {},
			random: () => 0.5
		}).run(created.id);

		expect(result).toMatchObject({
			outcome: 'failed',
			error: { code: 'MODEL_CALL_FAILED' },
			modelCallCount: 1
		});
		expect(model.calls).toHaveLength(3);
	});

	it('does not retry a failure the client classified as non-retryable', async () => {
		const repo = repository();
		const created = createCase(repo);
		const model = scriptedModel([
			new ModelClientError('bad request', { reason: 'http', status: 400 })
		]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient(),
			sleep: async () => {}
		}).run(created.id);

		expect(result).toMatchObject({ outcome: 'failed', error: { code: 'MODEL_CALL_FAILED' } });
		expect(model.calls).toHaveLength(1);
	});

	it('stops issuing model calls once the wall-clock budget is gone', async () => {
		const repo = repository();
		const created = createCase(repo);
		let clock = 0;
		const model = scriptedModel([
			JSON.stringify({ type: 'search_global', query: '住宿流程', count: 1 })
		]);

		const result = await createGuidanceRuntime({
			repository: repo,
			model,
			zhihu: zhihuClient([]),
			runBudgetMs: 1_000,
			now: () => (clock += 400),
			sleep: async () => {}
		}).run(created.id);

		expect(result).toMatchObject({
			outcome: 'failed',
			error: { code: 'TIME_BUDGET_EXCEEDED' }
		});
		expect(model.calls.length).toBeLessThan(5);
	});

	it('returns ready with partial completeness when salvage succeeds', async () => {
		const repo = repository();
		const created = createCase(repo);
		const model = scriptedModel([
			provide({
				understanding: { summary: '只保留了理解。', openPoint: null, sources: [] },
				communicationChecks: [{ bad: 'schema' }],
				nextStep: null,
				question: null,
				changeSummary: null
			})
		]);

		const result = await createGuidanceRuntime({ repository: repo, model, zhihu: zhihuClient() }).run(
			created.id
		);

		expect(result.outcome).toBe('ready');
		expect(result.guidance?.completeness).toBe('minimal');
		expect(result.guidance?.draft.understanding.summary).toBe('只保留了理解。');
		expect(result.guidance?.dropped.length).toBeGreaterThan(0);
	});
});

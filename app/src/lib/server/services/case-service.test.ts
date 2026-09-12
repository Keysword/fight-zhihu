import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCaseRepository, CaseNotFoundError } from '$lib/server/cases/repository';
import type { GuidanceDraft } from '$lib/domain/guidance';
import type { BackgroundBoard } from '$lib/domain/types';
import type { GuidanceRunResult } from '$lib/server/agent/guidance-runtime';
import { createCaseService, GuidanceModeDisabledError } from './case-service';

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function guidanceDraft(summary = '先核实负责方，再决定行动'): GuidanceDraft {
	return {
		understanding: { summary, openPoint: '仍需确认具体安排', sources: [] },
		communicationChecks: [],
		nextStep: {
			kind: 'contact',
			instruction: '联系负责方核实',
			why: '现有材料没有最终确认',
			contact: { label: '负责方', basis: 'suggested_role', sources: [] },
			message: '请问目前的具体安排是否已经确认？',
			branches: []
		},
		question: null,
		changeSummary: null
	};
}

function setup(mode: 'legacy' | 'guided' = 'legacy') {
	const directory = mkdtempSync(join(tmpdir(), 'background-service-'));
	directories.push(directory);
	const repository = createCaseRepository(join(directory, 'service.sqlite'));
	const legacyRunner = {
		run: vi.fn(async () => ({
			outcome: 'finished' as const,
			summary: '完成',
			turns: 1,
			revision: 0
		}))
	};
	const guidanceRunner = {
		run: vi.fn(async (caseId: string): Promise<GuidanceRunResult> => {
			const contextRevision = repository.getCaseContext(caseId).contextRevision;
			const saved = repository.saveGuidance(
				caseId,
				contextRevision,
				guidanceDraft(),
				[],
				crypto.randomUUID()
			);
			return {
				runId: saved.snapshot.runId,
				outcome: 'ready',
				guidance: saved.snapshot,
				contextRevision,
				modelCallCount: 1,
				searchCount: 0,
				repairCount: 0
			};
		})
	};
	const service = createCaseService({
		repository,
		runner: legacyRunner,
		guidanceRunner,
		configuration: {
			guidanceMode: mode === 'guided',
			modelConfigured: true,
			zhihuConfigured: true,
			version: 'test'
		}
	});
	return { repository, legacyRunner, guidanceRunner, service };
}

describe('case service', () => {
	it('redacts sensitive input before persistence', () => {
		const { repository, service } = setup();
		const result = service.createCase({
			title: '甲公司入职手续',
			goal: '确认甲公司材料',
			confusion: '赵老师让我拨打 13812345678，但没有说材料清单',
			replacements: [
				{ from: '赵老师', to: '人力老师' },
				{ from: '甲公司', to: '[单位]' }
			],
			evidence: [
				{
					kind: 'email',
					content: '发送到 a@example.com',
					sourceLabel: '甲公司通知',
					occurredAt: null
				}
			]
		});

		expect(result.mode).toBe('legacy');
		expect(result).toMatchObject({
			inputs: [],
			guidance: null,
			guidanceHistory: [],
			contextRevision: 1
		});
		expect(result.case.title).toBe('[单位]入职手续');
		expect(result.case.goal).toBe('确认[单位]材料');
		expect(result.case.confusion).toBe('人力老师让我拨打 [手机号]，但没有说材料清单');
		expect(result.case.evidence[0].content).toBe('发送到 [邮箱]');
		expect(result.case.evidence[0].sourceLabel).toBe('[单位]通知');
		expect(result.redactionCount).toBe(6);
		expect(JSON.stringify(result)).not.toContain('13812345678');
		repository.close();
	});

	it('creates and runs the marked dorm demonstration', async () => {
		const { repository, legacyRunner, service } = setup();
		const result = await service.createDemo();
		expect(result.case.evidence).toHaveLength(4);
		expect(result.case.board?.keyCompleter?.participantId).toBe('participant-hr');
		expect(result.events.some((event) => event.type === 'case.demo')).toBe(true);
		expect(result.events.some((event) => event.type === 'agent.fallback')).toBe(true);
		expect(legacyRunner.run).toHaveBeenCalledWith(result.case.id);
		repository.close();
	});

	it('still returns the reviewed demo board when the general agent fails', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'background-service-'));
		directories.push(directory);
		const repository = createCaseRepository(join(directory, 'failed-demo.sqlite'));
		const service = createCaseService({
			repository,
			runner: { run: vi.fn(async () => Promise.reject(new Error('model failed'))) },
			guidanceRunner: { run: vi.fn() },
			configuration: {
				guidanceMode: false,
				modelConfigured: true,
				zhihuConfigured: true,
				version: 'test'
			}
		});

		await expect(service.createDemo()).resolves.toMatchObject({
			case: { revision: 1, board: { keyCompleter: { participantId: 'participant-hr' } } },
			run: { outcome: 'fallback' }
		});
		repository.close();
	});

	it('appends evidence, runs the same case, and hides internal configuration', async () => {
		const { repository, legacyRunner, service } = setup();
		const created = service.createCase({
			title: '入职',
			goal: '完成手续',
			confusion: '不知道找谁'
		});
		const result = await service.appendEvidenceAndRun(created.case.id, {
			kind: 'message',
			content: '找部门 HR',
			sourceLabel: '同事',
			occurredAt: null
		});
		expect(result.case.evidence).toHaveLength(1);
		expect(legacyRunner.run).toHaveBeenCalledWith(created.case.id);
		expect(JSON.stringify(service.getCase(created.case.id))).not.toMatch(
			/API_KEY|ACCESS_SECRET|messages/i
		);
		repository.close();
	});

	it('keeps one appended evidence item and returns a recoverable result when the agent fails', async () => {
		const { repository, legacyRunner, service } = setup();
		legacyRunner.run.mockRejectedValueOnce(new Error('temporary model failure'));
		const created = service.createCase({
			title: '入职',
			goal: '完成手续',
			confusion: '不知道找谁'
		});
		const result = await service.appendEvidenceAndRun(created.case.id, {
			kind: 'message',
			content: '人力回复稍后确认',
			sourceLabel: '人力',
			occurredAt: null
		});
		expect(result.run).toMatchObject({ outcome: 'failed', revision: 0 });
		expect(result.case.evidence).toHaveLength(1);
		expect(result.events.some((event) => event.type === 'agent.run_failed')).toBe(true);
		repository.close();
	});

	it('returns health flags and rejects unknown case IDs', () => {
		const { repository, service } = setup();
		expect(service.health()).toEqual({
			version: 'test',
			databaseReady: true,
			modelConfigured: true,
			zhihuConfigured: true
		});
		expect(() => service.getCase('missing')).toThrow(CaseNotFoundError);
		repository.close();
	});

	it('rejects guided-only methods while legacy runCase remains available', async () => {
		const { repository, legacyRunner, guidanceRunner, service } = setup('legacy');
		const created = service.createCase({ title: '事项', goal: '推进', confusion: '未知' });

		expect(() =>
			service.appendCaseInput(created.case.id, {
				kind: 'context',
				content: '新增情况',
				guidanceId: null,
				requestId: crypto.randomUUID()
			})
		).toThrow(GuidanceModeDisabledError);
		await expect(service.runGuidance(created.case.id)).rejects.toBeInstanceOf(
			GuidanceModeDisabledError
		);
		await expect(service.runCase(created.case.id)).resolves.toMatchObject({
			run: { outcome: 'finished' }
		});
		expect(legacyRunner.run).toHaveBeenCalledOnce();
		expect(guidanceRunner.run).not.toHaveBeenCalled();
		repository.close();
	});

	it('confirms a server-staged board proposal without accepting a client board', () => {
		const { repository, service } = setup();
		const created = service.createCase({
			title: '入职',
			goal: '完成手续',
			confusion: '不知道找谁'
		});
		const initial: BackgroundBoard = {
			caseId: created.case.id,
			title: created.case.title,
			goal: created.case.goal,
			stage: 'understanding',
			currentBlocker: '缺少联系人',
			claims: [],
			participants: [],
			keyCompleter: null,
			nextAction: null,
			externalClues: [],
			updatedAt: new Date().toISOString()
		};
		repository.saveBoard(created.case.id, 0, initial);
		repository.stageBoardProposal(created.case.id, 1, {
			...initial,
			currentBlocker: '等待人力回复'
		});
		const reviewed = service.reviewBoardProposal(created.case.id, {
			action: 'confirm',
			expectedRevision: 1
		});
		expect(reviewed.case.revision).toBe(2);
		expect(reviewed.case.board?.currentBlocker).toBe('等待人力回复');
		expect(reviewed.events.at(-1)?.type).toBe('board.proposal_confirmed');
		repository.close();
	});

	// 用户在证据轨上确认“这条是负责方明确回复过”，之后模型才能据此写 fact。
	it('lets the user promote an evidence item to confirmed', () => {
		const { repository, service } = setup();
		const created = service.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '不清楚',
			evidence: [
				{
					kind: 'message',
					content: '物业回复：房间已经分配。',
					sourceLabel: '物业',
					occurredAt: null
				}
			]
		});
		const evidenceId = created.case.evidence[0].id;
		expect(created.case.evidence[0].confirmation).toBe('self_reported');

		const confirmed = service.confirmEvidence(created.case.id, evidenceId);

		expect(confirmed.case.evidence[0].confirmation).toBe('official');
		expect(confirmed.events.at(-1)?.type).toBe('evidence.confirmed');
		expect(confirmed.events.at(-1)?.payload.evidenceId).toBe(evidenceId);
		repository.close();
	});

	it('rejects confirming evidence that does not belong to the case', () => {
		const { repository, service } = setup();
		const created = service.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '不清楚'
		});
		expect(() => service.confirmEvidence(created.case.id, 'not-a-real-evidence')).toThrow(
			/找不到证据/
		);
		repository.close();
	});

	it('builds the complete server-driven view in either mode and keeps stale guidance history', () => {
		const { repository, service } = setup('guided');
		const created = service.createCase({
			title: '事项',
			goal: '得到下一步',
			confusion: '信息不全'
		});
		const first = repository.saveGuidance(
			created.case.id,
			0,
			guidanceDraft('第一版理解'),
			[],
			crypto.randomUUID()
		);

		const current = service.getCase(created.case.id);
		expect(current).toMatchObject({
			mode: 'guided',
			inputs: [],
			contextRevision: 0,
			guidance: { id: first.snapshot.id, draft: { understanding: { summary: '第一版理解' } } }
		});
		expect(current.guidanceHistory).toEqual([
			{
				id: first.snapshot.id,
				contextRevision: 0,
				createdAt: first.snapshot.createdAt,
				understandingSummary: '第一版理解',
				changeSummary: null,
				hasQuestion: false
			}
		]);

		repository.appendCaseInput(created.case.id, {
			kind: 'correction',
			content: '这条理解需要修正',
			guidanceId: first.snapshot.id,
			requestId: crypto.randomUUID()
		});
		const stale = service.getCase(created.case.id);
		expect(stale.contextRevision).toBe(1);
		expect(stale.guidance).toBeNull();
		expect(stale.guidanceHistory).toEqual(current.guidanceHistory);
		expect(stale.inputs).toHaveLength(1);
		repository.close();
	});

	it('returns at most twenty guidance summaries and loads scoped details on demand', () => {
		const { repository, service } = setup('guided');
		const created = service.createCase({ title: '事项', goal: '推进', confusion: '未知' });
		const other = service.createCase({ title: '其他', goal: '推进', confusion: '未知' });
		const snapshots = Array.from(
			{ length: 25 },
			(_, index) =>
				repository.saveGuidance(
					created.case.id,
					0,
					{
						...guidanceDraft(`理解 ${index + 1}`),
						question: index === 24 ? '最后一个问题？' : null,
						changeSummary: index === 24 ? '最后一次变化' : null
					},
					[],
					crypto.randomUUID()
				).snapshot
		);

		const view = service.getCase(created.case.id);
		expect(view.guidanceHistory).toHaveLength(20);
		expect(view.guidanceHistory[0]).toMatchObject({
			id: snapshots[5].id,
			understandingSummary: '理解 6',
			hasQuestion: false
		});
		expect(view.guidanceHistory.at(-1)).toEqual({
			id: snapshots[24].id,
			contextRevision: 0,
			createdAt: snapshots[24].createdAt,
			understandingSummary: '理解 25',
			changeSummary: '最后一次变化',
			hasQuestion: true
		});
		expect(service.getGuidance(created.case.id, snapshots[0].id)).toEqual(snapshots[0]);
		expect(() => service.getGuidance(other.case.id, snapshots[0].id)).toThrow(
			'指导引用无效或不属于当前案例'
		);
		expect(() => service.getGuidance(other.case.id, 'missing')).toThrow(
			'指导引用无效或不属于当前案例'
		);
		repository.close();
	});

	it('stores a redacted input once and never persists replacement rules', () => {
		const { repository, service } = setup('guided');
		const created = service.createCase({ title: '事项', goal: '推进', confusion: '未知' });
		const requestId = crypto.randomUUID();
		const request = {
			kind: 'question' as const,
			content: '请联系赵老师，电话 13812345678',
			guidanceId: null,
			requestId,
			replacements: [{ from: '赵老师', to: '负责老师' }]
		};

		const inserted = service.appendCaseInput(created.case.id, request);
		const replayed = service.appendCaseInput(created.case.id, request);

		expect(inserted).toMatchObject({
			outcome: 'inserted',
			redactionCount: 2,
			input: { content: '请联系负责老师，电话 [手机号]', contextRevision: 1 },
			contextRevision: 1
		});
		expect(replayed).toMatchObject({ outcome: 'replayed', contextRevision: 1 });
		expect(repository.listCaseInputs(created.case.id)).toHaveLength(1);
		expect(
			repository.listEvents(created.case.id).filter((event) => event.type === 'case.input_added')
		).toHaveLength(0);
		expect(JSON.stringify(repository.listCaseInputs(created.case.id))).not.toContain(
			'replacements'
		);
		expect(() =>
			service.appendCaseInput(created.case.id, { ...request, content: '同一请求的不同内容' })
		).toThrow(/已用于不同的输入/);
		repository.close();
	});

	it('does not reveal whether a referenced guidance belongs to another case', () => {
		const { repository, service } = setup('guided');
		const first = service.createCase({ title: 'A', goal: '推进 A', confusion: '未知' });
		const second = service.createCase({ title: 'B', goal: '推进 B', confusion: '未知' });
		const saved = repository.saveGuidance(
			first.case.id,
			0,
			guidanceDraft(),
			[],
			crypto.randomUUID()
		);
		const request = {
			kind: 'correction' as const,
			content: '并不是这样',
			requestId: crypto.randomUUID(),
			replacements: []
		};

		expect(() =>
			service.appendCaseInput(second.case.id, { ...request, guidanceId: saved.snapshot.id })
		).toThrow('指导引用无效或不属于当前案例');
		expect(() =>
			service.appendCaseInput(second.case.id, {
				...request,
				requestId: crypto.randomUUID(),
				guidanceId: 'missing'
			})
		).toThrow('指导引用无效或不属于当前案例');
		repository.close();
	});

	it('routes guided run and evidence analysis only to the guidance runner', async () => {
		const { repository, legacyRunner, guidanceRunner, service } = setup('guided');
		const created = service.createCase({ title: '事项', goal: '推进', confusion: '未知' });

		const runResult = await service.runCase(created.case.id);
		const evidenceResult = await service.appendEvidenceAndRun(created.case.id, {
			kind: 'message',
			content: '负责方暂未回复',
			sourceLabel: '负责方',
			occurredAt: null
		});

		expect(runResult.run.outcome).toBe('ready');
		expect(evidenceResult.run.outcome).toBe('ready');
		expect(guidanceRunner.run).toHaveBeenCalledTimes(2);
		expect(legacyRunner.run).not.toHaveBeenCalled();
		expect(evidenceResult.case.evidence).toHaveLength(1);
		repository.close();
	});

	it('keeps a saved input when a guidance run returns a normal failure', async () => {
		const { repository, guidanceRunner, service } = setup('guided');
		guidanceRunner.run.mockResolvedValueOnce({
			runId: crypto.randomUUID(),
			outcome: 'failed',
			guidance: null,
			error: { code: 'MODEL_CALL_FAILED', message: '模型调用失败' },
			contextRevision: 1,
			modelCallCount: 1,
			searchCount: 0,
			repairCount: 0
		});
		const created = service.createCase({ title: '事项', goal: '推进', confusion: '未知' });
		service.appendCaseInput(created.case.id, {
			kind: 'context',
			content: '新增情况',
			guidanceId: null,
			requestId: crypto.randomUUID()
		});

		const result = await service.runGuidance(created.case.id);

		expect(result.run).toMatchObject({ outcome: 'failed', error: { code: 'MODEL_CALL_FAILED' } });
		expect(result.inputs).toHaveLength(1);
		expect(result.contextRevision).toBe(1);
		repository.close();
	});

	it('turns a rejected guided run into recoverable data while preserving inputs and evidence', async () => {
		const { repository, guidanceRunner, service } = setup('guided');
		const created = service.createCase({ title: '事项', goal: '推进', confusion: '未知' });
		const prior = repository.saveGuidance(
			created.case.id,
			0,
			guidanceDraft('运行前已有理解'),
			[],
			crypto.randomUUID()
		).snapshot;
		guidanceRunner.run.mockRejectedValue(new Error('unexpected runner rejection'));

		const direct = await service.runGuidance(created.case.id);
		service.appendCaseInput(created.case.id, {
			kind: 'context',
			content: '先保存的输入',
			guidanceId: null,
			requestId: crypto.randomUUID()
		});

		const rerun = await service.runCase(created.case.id);
		const evidence = await service.appendEvidenceAndRun(created.case.id, {
			kind: 'message',
			content: '刚保存的材料',
			sourceLabel: '负责方',
			occurredAt: null
		});

		for (const result of [direct, rerun, evidence]) {
			expect(result.run).toMatchObject({
				outcome: 'failed',
				guidance: null,
				error: {
					code: 'GUIDANCE_RUN_FAILED',
					message: '材料/输入已保存，本轮未完成，可以稍后重试'
				}
			});
		}
		expect(direct.guidance).toEqual(prior);
		expect(direct.guidanceHistory).toHaveLength(1);
		expect(evidence.inputs).toHaveLength(1);
		expect(evidence.case.evidence).toHaveLength(1);
		expect(evidence.guidance).toBeNull();
		expect(evidence.guidanceHistory).toHaveLength(1);
		expect(
			repository
				.listEvents(created.case.id)
				.filter((event) => event.type === 'guidance.run.finished')
		).toEqual([]);
		repository.close();
	});

	it('keeps model questions in the current guidance view', async () => {
		const { repository, guidanceRunner, service } = setup('guided');
		guidanceRunner.run.mockImplementationOnce(async (caseId) => {
			const contextRevision = repository.getCaseContext(caseId).contextRevision;
			const draft = { ...guidanceDraft(), question: '你是否已经收到正式邮件？' };
			const saved = repository.saveGuidance(
				caseId,
				contextRevision,
				draft,
				[],
				crypto.randomUUID()
			);
			return {
				runId: saved.snapshot.runId,
				outcome: 'needs_input',
				guidance: saved.snapshot,
				contextRevision,
				modelCallCount: 1,
				searchCount: 0,
				repairCount: 0
			};
		});
		const created = service.createCase({ title: '事项', goal: '推进', confusion: '未知' });

		await service.runGuidance(created.case.id);
		expect(service.getCase(created.case.id).guidance?.draft.question).toBe(
			'你是否已经收到正式邮件？'
		);
		repository.close();
	});

	it('uses a clearly marked fixed Guidance fallback only for the guided demo', async () => {
		const { repository, legacyRunner, guidanceRunner, service } = setup('guided');
		guidanceRunner.run.mockResolvedValueOnce({
			runId: crypto.randomUUID(),
			outcome: 'failed',
			guidance: null,
			error: { code: 'MODEL_NOT_CONFIGURED', message: '尚未配置模型' },
			contextRevision: 4,
			modelCallCount: 0,
			searchCount: 0,
			repairCount: 0
		});

		const result = await service.createDemo();

		expect(result.mode).toBe('guided');
		expect(result.run).toMatchObject({
			outcome: 'ready',
			guidance: { draft: { changeSummary: '固定演示样例' } }
		});
		expect(result.guidance?.draft.understanding.summary).toContain('接引安排不能证明');
		const evidenceIds = new Set(result.case.evidence.map((item) => item.id));
		for (const source of result.guidance?.draft.understanding.sources ?? []) {
			expect(source.kind).toBe('evidence');
			expect(evidenceIds.has(source.id)).toBe(true);
		}
		const evidenceByLabel = new Map(
			result.case.evidence.map((evidence) => [evidence.sourceLabel, evidence.id])
		);
		expect(result.guidance?.draft.communicationChecks[0].sources).toEqual([
			{ kind: 'evidence', id: evidenceByLabel.get('部门对接人') },
			{ kind: 'evidence', id: evidenceByLabel.get('接引同事') }
		]);
		expect(result.guidance?.draft.nextStep?.contact).toEqual({
			label: '人力 / 住宿管理方',
			basis: 'suggested_role',
			sources: []
		});
		expect(result.case.board).toBeNull();
		expect(legacyRunner.run).not.toHaveBeenCalled();
		repository.close();
	});

	it('records evidence confirmation only when it changes the context revision', () => {
		const { repository, service } = setup('guided');
		const created = service.createCase({
			title: '事项',
			goal: '推进',
			confusion: '未知',
			evidence: [{ kind: 'message', content: '已有回复', sourceLabel: '负责方', occurredAt: null }]
		});
		const evidenceId = created.case.evidence[0].id;

		service.confirmEvidence(created.case.id, evidenceId);
		service.confirmEvidence(created.case.id, evidenceId);

		expect(repository.getCaseContext(created.case.id).contextRevision).toBe(2);
		expect(
			repository.listEvents(created.case.id).filter((event) => event.type === 'evidence.confirmed')
		).toHaveLength(1);
		repository.close();
	});
});

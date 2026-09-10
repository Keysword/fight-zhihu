import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dormDemoEvidence } from '$lib/domain/demo-case';
import type { BackgroundBoard, ExternalClue } from '$lib/domain/types';
import { createCaseRepository, RevisionConflictError } from '$lib/server/cases/repository';
import { ModelConfigurationError, type ModelClient, type ModelMessage } from './model-client';
import { AgentLimitError, AgentSafetyError, createAgentRuntime } from './runtime';

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function repository() {
	const directory = mkdtempSync(join(tmpdir(), 'background-agent-'));
	directories.push(directory);
	return createCaseRepository(join(directory, 'runtime.sqlite'));
}

function validBoard(caseId: string, evidenceId: string): BackgroundBoard {
	return {
		caseId,
		title: '宿舍入住',
		goal: '确认能否入住',
		stage: 'actionable',
		currentBlocker: '房间号尚未确认',
		claims: [
			{ id: 'claim-1', kind: 'statement', text: '同事表示以邮件为准', evidenceIds: [evidenceId] }
		],
		participants: [
			{
				id: 'hr',
				name: '人力老师',
				role: '住宿通知',
				providedInfo: ['以邮件为准'],
				capabilities: ['查询通知状态'],
				decisionScopes: ['住宿通知'],
				coordinationScopes: ['联系物业'],
				evidenceIds: [evidenceId]
			}
		],
		keyCompleter: {
			participantId: 'hr',
			scope: '确认住宿通知',
			rationale: '其正式职责覆盖住宿通知',
			confidence: 'high',
			uncertainty: '尚不确定其是否已收到物业结果',
			evidenceIds: [evidenceId]
		},
		nextAction: {
			contactParticipantId: 'hr',
			question: '房间是否分配？',
			why: '这是入住的关键缺口',
			message:
				'您好，我了解到住宿以邮件为准，但尚未收到房间信息，想请您协助确认房间是否已经分配，谢谢。',
			branches: [{ when: '已分配', then: '确认钥匙交付方式' }]
		},
		externalClues: [],
		updatedAt: new Date().toISOString()
	};
}

function scriptedModel(responses: string[]): ModelClient & { calls: ModelMessage[][] } {
	const calls: ModelMessage[][] = [];
	let index = 0;
	return {
		calls,
		async complete(messages) {
			calls.push(structuredClone(messages));
			return responses[Math.min(index++, responses.length - 1)];
		}
	};
}

const clue: ExternalClue = {
	id: 'zhihu-42',
	title: '新人住宿经验',
	excerpt: '先确认资格',
	url: 'https://www.zhihu.com/answer/42',
	author: '知乎用户',
	editedAt: null,
	authorityLevel: '2',
	source: 'zhihu',
	relevance: '类似场景',
	warning: '外部内容不是本案例事实'
};

describe('stateful agent runtime', () => {
	it('follows the model-selected order and persists the board', async () => {
		const repo = repository();
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间号'
		});
		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '人力说以邮件为准',
			sourceLabel: '人力',
			occurredAt: null
		});
		const board = validBoard(created.id, evidence.id);
		const model = scriptedModel([
			JSON.stringify({ type: 'search_zhihu', query: '新人 宿舍 入住', count: 3 }),
			JSON.stringify({ type: 'propose_board_patch', board, summary: '整理当前缺口' }),
			JSON.stringify({ type: 'finish', summary: '已经形成可执行询问' })
		]);
		const zhihu = {
			searchZhihu: vi.fn(async () => [clue]),
			searchGlobal: vi.fn(async () => [])
		};

		const result = await createAgentRuntime({ repository: repo, model, zhihu }).run(created.id);

		expect(result.outcome).toBe('finished');
		expect(repo.getCase(created.id)?.board?.keyCompleter?.participantId).toBe('hr');
		expect(zhihu.searchZhihu).toHaveBeenCalledTimes(1);
		expect(model.calls[1].some((message) => message.content.includes('zhihu-42'))).toBe(true);
		expect(
			repo.listEvents(created.id).filter((event) => event.type === 'agent.action')
		).toHaveLength(3);
		repo.close();
	});

	it('caps searches at two calls', async () => {
		const repo = repository();
		const created = repo.createCase({ title: '事项', goal: '解决', confusion: '不清楚' });
		const model = scriptedModel([
			'{"type":"search_zhihu","query":"一","count":1}',
			'{"type":"search_global","query":"二","count":1}',
			'{"type":"search_zhihu","query":"三","count":1}'
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).rejects.toBeInstanceOf(AgentLimitError);
		expect(zhihu.searchZhihu).toHaveBeenCalledTimes(1);
		expect(zhihu.searchGlobal).toHaveBeenCalledTimes(1);
		repo.close();
	});

	it('gives the model one protocol repair turn without persisting private prose', async () => {
		const repo = repository();
		const created = repo.createCase({ title: '事项', goal: '解决', confusion: '不清楚' });
		const model = scriptedModel([
			'我先分析一下这个问题。',
			'{"type":"ask_user","question":"请补充正式通知原文。"}'
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).resolves.toMatchObject({
			outcome: 'needs_input',
			turns: 2
		});
		const events = repo.listEvents(created.id);
		expect(events.some((event) => event.type === 'agent.protocol_repair')).toBe(true);
		expect(JSON.stringify(events)).not.toContain('我先分析一下');
		repo.close();
	});

	it('does not allow finish before a board exists', async () => {
		const repo = repository();
		const created = repo.createCase({ title: '事项', goal: '解决', confusion: '不清楚' });
		const model = scriptedModel([
			'{"type":"finish","summary":"已经完成"}',
			'{"type":"ask_user","question":"请补充一条通知。"}'
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };
		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).resolves.toMatchObject({ outcome: 'needs_input', question: '请补充一条通知。' });
		expect(repo.listEvents(created.id).some((event) => event.type === 'agent.invalid_finish')).toBe(
			true
		);
		repo.close();
	});

	it('redacts outbound search queries and continues when Zhihu is unavailable', async () => {
		const repo = repository();
		const created = repo.createCase({ title: '权限', goal: '开通权限', confusion: '不知道找谁' });
		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '张老师说需要再问管理员，电话 13812345678',
			sourceLabel: '张老师',
			occurredAt: null
		});
		const board = validBoard(created.id, evidence.id);
		board.title = created.title;
		board.goal = created.goal;
		const model = scriptedModel([
			'{"type":"search_zhihu","query":"甲公司 张老师 13812345678 入职权限","count":1}',
			JSON.stringify({ type: 'propose_board_patch', board, summary: '整理现有信息' }),
			'{"type":"finish","summary":"形成背景板"}'
		]);
		const zhihu = {
			searchZhihu: vi.fn(async () => Promise.reject(new Error('quota'))),
			searchGlobal: vi.fn(async () => [])
		};
		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).resolves.toMatchObject({ outcome: 'finished' });
		expect(zhihu.searchZhihu).toHaveBeenCalledWith('[单位] [联系人] [手机号] 入职权限', 1);
		expect(repo.getCase(created.id)?.board).not.toBeNull();
		expect(repo.listEvents(created.id).some((event) => event.type === 'tool.error')).toBe(true);
		repo.close();
	});

	it('rejects board facts that cite evidence outside the case', async () => {
		const repo = repository();
		const created = repo.createCase({ title: '事项', goal: '解决', confusion: '不清楚' });
		const board = validBoard(created.id, 'not-in-this-case');
		const model = scriptedModel([
			JSON.stringify({ type: 'propose_board_patch', board, summary: '错误更新' })
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).rejects.toBeInstanceOf(AgentSafetyError);
		expect(repo.getCase(created.id)?.board).toBeNull();
		repo.close();
	});

	it('does not overwrite the current board after a revision conflict', async () => {
		const baseRepo = repository();
		const created = baseRepo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '不清楚'
		});
		const evidence = baseRepo.appendEvidence(created.id, {
			kind: 'note',
			content: '已有证据',
			sourceLabel: '本人',
			occurredAt: null
		});
		const board = validBoard(created.id, evidence.id);
		const conflictingRepo = {
			...baseRepo,
			saveBoard: () => {
				throw new RevisionConflictError();
			}
		};
		const model = scriptedModel([
			JSON.stringify({ type: 'propose_board_patch', board, summary: '尝试更新' })
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		await expect(
			createAgentRuntime({ repository: conflictingRepo, model, zhihu }).run(created.id)
		).rejects.toBeInstanceOf(RevisionConflictError);
		expect(baseRepo.getCase(created.id)?.board).toBeNull();
		baseRepo.close();
	});

	it('stages updates to an existing board for user review', async () => {
		const repo = repository();
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '不清楚'
		});
		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '人力说以邮件为准',
			sourceLabel: '人力',
			occurredAt: null
		});
		const initial = validBoard(created.id, evidence.id);
		repo.saveBoard(created.id, 0, initial);
		const proposal = { ...structuredClone(initial), currentBlocker: '等待正式邮件到达' };
		const model = scriptedModel([
			JSON.stringify({ type: 'propose_board_patch', board: proposal, summary: '更新阻塞点' }),
			'{"type":"finish","summary":"请用户审阅变化"}'
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };
		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).resolves.toMatchObject({
			outcome: 'review_required',
			revision: 1,
			proposedBoard: { currentBlocker: '等待正式邮件到达' }
		});
		expect(repo.getCase(created.id)?.board?.currentBlocker).toBe('房间号尚未确认');
		expect(repo.getCase(created.id)?.pendingBoard?.currentBlocker).toBe('等待正式邮件到达');
		repo.close();
	});

	it('returns the current board when the turn budget runs out', async () => {
		const repo = repository();
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间号'
		});
		const evidence = repo.appendEvidence(created.id, {
			kind: 'note',
			content: '人力说以邮件为准',
			sourceLabel: '本人',
			occurredAt: null
		});
		const action = JSON.stringify({
			type: 'propose_board_patch',
			board: validBoard(created.id, evidence.id),
			summary: '持续整理'
		});
		const model = scriptedModel([action]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		const result = await createAgentRuntime({ repository: repo, model, zhihu }).run(created.id);

		expect(result.outcome).toBe('partial');
		// 新案例的板已经直接落库，不是待审提案。
		// 返回它会让前端显示一个点了就报错的确认入口。
		expect(result.proposedBoard).toBeUndefined();
		expect(repo.getCase(created.id)?.board).not.toBeNull();
		expect(repo.getCase(created.id)?.pendingBoard ?? null).toBeNull();
		expect(result.turns).toBe(6);
		expect(model.calls).toHaveLength(6);
		const events = repo.listEvents(created.id);
		expect(events.some((event) => event.type === 'agent.limit')).toBe(true);
		expect(events.at(-1)?.type).toBe('agent.finished');
		expect(events.at(-1)?.payload.outcome).toBe('partial');
		repo.close();
	});

	it('still fails when the turn budget runs out before any board exists', async () => {
		const repo = repository();
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间号'
		});
		const model = scriptedModel(['{"type":"search_zhihu","query":"新人入住","count":1}']);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).rejects.toBeInstanceOf(AgentLimitError);
		expect(repo.getCase(created.id)?.board).toBeNull();
		repo.close();
	});

	it('gives the model one safety repair turn with the exact rejection reason', async () => {
		const repo = repository();
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '不清楚'
		});
		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '同事说需要再问管理员',
			sourceLabel: '同事',
			occurredAt: null
		});
		const invalid = validBoard(created.id, 'not-in-this-case');
		const corrected = validBoard(created.id, evidence.id);
		const model = scriptedModel([
			JSON.stringify({ type: 'propose_board_patch', board: invalid, summary: '错误更新' }),
			JSON.stringify({ type: 'propose_board_patch', board: corrected, summary: '修正后的更新' }),
			'{"type":"finish","summary":"已修正确认"}'
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		const result = await createAgentRuntime({ repository: repo, model, zhihu }).run(created.id);

		expect(result.outcome).toBe('finished');
		expect(repo.getCase(created.id)?.board?.currentBlocker).toBe('房间号尚未确认');
		const repair = model.calls[1].find((message) => message.content.includes('安全校验'));
		expect(repair?.content).toContain('不属于本案例的证据');
		expect(repo.listEvents(created.id).some((event) => event.type === 'agent.safety_repair')).toBe(
			true
		);
		expect(repo.listEvents(created.id).some((event) => event.type === 'agent.error')).toBe(false);
		repo.close();
	});

	it('fails after a second rejected board and records the safety reason', async () => {
		const repo = repository();
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '不清楚'
		});
		const invalid = validBoard(created.id, 'not-in-this-case');
		const action = JSON.stringify({
			type: 'propose_board_patch',
			board: invalid,
			summary: '持续错误'
		});
		const model = scriptedModel([action]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).rejects.toBeInstanceOf(AgentSafetyError);
		expect(model.calls).toHaveLength(2);
		const last = repo.listEvents(created.id).at(-1);
		expect(last?.type).toBe('agent.error');
		expect(last?.payload.category).toBe('safety');
		expect(String(last?.payload.reason)).toContain('不属于本案例的证据');
		repo.close();
	});

	it('accepts a fact that cites evidence the user confirmed', async () => {
		const repo = repository();
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '不清楚'
		});
		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '物业已确认房间已经分配',
			sourceLabel: '物业',
			occurredAt: null,
			confirmation: 'official'
		});
		const board = validBoard(created.id, evidence.id);
		board.claims[0] = {
			id: 'claim-1',
			kind: 'fact',
			text: '房间已经分配',
			evidenceIds: [evidence.id]
		};
		const model = scriptedModel([
			JSON.stringify({ type: 'propose_board_patch', board, summary: '记录已确认事实' }),
			'{"type":"finish","summary":"完成"}'
		]);
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		const result = await createAgentRuntime({ repository: repo, model, zhihu }).run(created.id);

		expect(result.outcome).toBe('finished');
		expect(repo.getCase(created.id)?.board?.claims[0].kind).toBe('fact');
		repo.close();
	});

	it('uses reviewed fallback only for a marked demo case', async () => {
		const repo = repository();
		const demo = repo.createCase({
			title: '新人入住宿舍',
			goal: '确认 8 月 2 日到达后是否可以实际入住',
			confusion: '不知道是否已分房以及钥匙由谁交付'
		});
		for (const evidence of dormDemoEvidence) {
			repo.appendEvidence(demo.id, {
				kind: evidence.kind,
				content: evidence.content,
				sourceLabel: evidence.sourceLabel,
				occurredAt: evidence.occurredAt
			});
		}
		repo.appendEvent(demo.id, { type: 'case.demo', payload: { fixture: 'dorm' } });
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };

		await expect(
			createAgentRuntime({ repository: repo, model: null, zhihu }).run(demo.id)
		).resolves.toMatchObject({
			outcome: 'fallback',
			revision: 1
		});
		expect(repo.getCase(demo.id)?.board?.nextAction?.message).toContain('房间是否已经分配');

		const regular = repo.createCase({ title: '普通案例', goal: '解决问题', confusion: '背景不清' });
		await expect(
			createAgentRuntime({ repository: repo, model: null, zhihu }).run(regular.id)
		).rejects.toBeInstanceOf(ModelConfigurationError);
		repo.close();
	});

	it('keeps the marked demo update reviewable when the model finishes without a patch', async () => {
		const repo = repository();
		const demo = repo.createCase({
			title: '新人入住宿舍',
			goal: '确认 8 月 2 日到达后是否可以实际入住',
			confusion: '不知道是否已分房以及钥匙由谁交付'
		});
		for (const evidence of dormDemoEvidence)
			repo.appendEvidence(demo.id, {
				kind: evidence.kind,
				content: evidence.content,
				sourceLabel: evidence.sourceLabel,
				occurredAt: evidence.occurredAt
			});
		repo.appendEvent(demo.id, { type: 'case.demo', payload: { fixture: 'dorm' } });
		const zhihu = { searchZhihu: vi.fn(async () => []), searchGlobal: vi.fn(async () => []) };
		await createAgentRuntime({ repository: repo, model: null, zhihu }).run(demo.id);
		repo.appendEvidence(demo.id, {
			kind: 'message',
			content: '物业刚回复：房间已经分配，钥匙在前台领取。',
			sourceLabel: '我的补充',
			occurredAt: null
		});
		const model = scriptedModel(['{"type":"finish","summary":"无需更新"}']);
		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(demo.id)
		).resolves.toMatchObject({
			outcome: 'review_required',
			proposedBoard: { stage: 'actionable' }
		});
		expect(repo.getCase(demo.id)?.pendingBoard?.keyCompleter?.participantId).toBe(
			'participant-property'
		);
		repo.close();
	});
});

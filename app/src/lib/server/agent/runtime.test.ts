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

	it('stops after six autonomous decisions', async () => {
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

		await expect(
			createAgentRuntime({ repository: repo, model, zhihu }).run(created.id)
		).rejects.toBeInstanceOf(AgentLimitError);
		expect(model.calls).toHaveLength(6);
		expect(repo.listEvents(created.id).at(-1)?.type).toBe('agent.limit');
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
});

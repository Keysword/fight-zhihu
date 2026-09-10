import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCaseRepository, CaseNotFoundError } from '$lib/server/cases/repository';
import type { BackgroundBoard } from '$lib/domain/types';
import { createCaseService } from './case-service';

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'background-service-'));
	directories.push(directory);
	const repository = createCaseRepository(join(directory, 'service.sqlite'));
	const runner = {
		run: vi.fn(async () => ({
			outcome: 'finished' as const,
			summary: '完成',
			turns: 1,
			revision: 0
		}))
	};
	const service = createCaseService({
		repository,
		runner,
		configuration: { modelConfigured: true, zhihuConfigured: true, version: 'test' }
	});
	return { repository, runner, service };
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
		const { repository, runner, service } = setup();
		const result = await service.createDemo();
		expect(result.case.evidence).toHaveLength(4);
		expect(result.case.board?.keyCompleter?.participantId).toBe('participant-hr');
		expect(result.events.some((event) => event.type === 'case.demo')).toBe(true);
		expect(result.events.some((event) => event.type === 'agent.fallback')).toBe(true);
		expect(runner.run).toHaveBeenCalledWith(result.case.id);
		repository.close();
	});

	it('still returns the reviewed demo board when the general agent fails', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'background-service-'));
		directories.push(directory);
		const repository = createCaseRepository(join(directory, 'failed-demo.sqlite'));
		const service = createCaseService({
			repository,
			runner: { run: vi.fn(async () => Promise.reject(new Error('model failed'))) },
			configuration: { modelConfigured: true, zhihuConfigured: true, version: 'test' }
		});

		await expect(service.createDemo()).resolves.toMatchObject({
			case: { revision: 1, board: { keyCompleter: { participantId: 'participant-hr' } } },
			run: { outcome: 'fallback' }
		});
		repository.close();
	});

	it('appends evidence, runs the same case, and hides internal configuration', async () => {
		const { repository, runner, service } = setup();
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
		expect(runner.run).toHaveBeenCalledWith(created.case.id);
		expect(JSON.stringify(service.getCase(created.case.id))).not.toMatch(
			/API_KEY|ACCESS_SECRET|messages/i
		);
		repository.close();
	});

	it('keeps one appended evidence item and returns a recoverable result when the agent fails', async () => {
		const { repository, runner, service } = setup();
		runner.run.mockRejectedValueOnce(new Error('temporary model failure'));
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
});

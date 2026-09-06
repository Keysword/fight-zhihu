import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { BackgroundBoard } from '$lib/domain/types';
import { createCaseRepository, RevisionConflictError } from './repository';

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'background-board-'));
	temporaryDirectories.push(directory);
	return join(directory, 'cases.sqlite');
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function boardFor(caseId: string, title: string): BackgroundBoard {
	return {
		caseId,
		title,
		goal: '确认能否入住',
		stage: 'understanding',
		currentBlocker: '缺少房间分配信息',
		claims: [],
		participants: [],
		keyCompleter: null,
		nextAction: null,
		externalClues: [],
		updatedAt: new Date().toISOString()
	};
}

describe('case repository', () => {
	it('creates a case, appends evidence, and records ordered events', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间信息'
		});

		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '以邮件为准',
			sourceLabel: '同事',
			occurredAt: null
		});
		repo.appendEvent(created.id, { type: 'agent.action', payload: { tool: 'read_case' } });
		repo.appendEvent(created.id, { type: 'agent.finished', payload: { outcome: 'waiting' } });

		const loaded = repo.getCase(created.id);
		expect(loaded?.evidence).toEqual([evidence]);
		expect(repo.listCases()).toHaveLength(1);
		expect(repo.listEvents(created.id).map((event) => event.type)).toEqual([
			'agent.action',
			'agent.finished'
		]);
		repo.close();
	});

	it('updates a board only at the expected revision', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间信息'
		});

		const saved = repo.saveBoard(created.id, 0, boardFor(created.id, created.title));
		expect(saved.revision).toBe(1);
		expect(saved.board?.currentBlocker).toBe('缺少房间分配信息');
		expect(() => repo.saveBoard(created.id, 0, boardFor(created.id, created.title))).toThrow(
			RevisionConflictError
		);
		repo.close();
	});

	it('rejects a board for a different case', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({ title: '事项', goal: '解决问题', confusion: '背景不清' });
		expect(() => repo.saveBoard(created.id, 0, boardFor('another-case', '事项'))).toThrow(
			/案例不一致/
		);
		repo.close();
	});

	it('stages a proposal without replacing the current board until confirmation', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间信息'
		});
		const initial = boardFor(created.id, created.title);
		repo.saveBoard(created.id, 0, initial);
		const proposal = { ...initial, currentBlocker: '只差钥匙领取时间' };
		const staged = repo.stageBoardProposal(created.id, 1, proposal);
		expect(staged.revision).toBe(1);
		expect(staged.board?.currentBlocker).toBe('缺少房间分配信息');
		expect(staged.pendingBoard?.currentBlocker).toBe('只差钥匙领取时间');
		const confirmed = repo.confirmBoardProposal(created.id, 1);
		expect(confirmed.revision).toBe(2);
		expect(confirmed.board?.currentBlocker).toBe('只差钥匙领取时间');
		expect(confirmed.pendingBoard).toBeNull();
		repo.close();
	});
});
